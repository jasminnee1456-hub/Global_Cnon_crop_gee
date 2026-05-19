// ================ User configuration section (modify as needed) ================
// Batch calculation years (does not change the alpha/beta historical period, which remains 1994-2023)
var START_YEAR = 2001;
var END_YEAR   = 2024;

// Asset path prefix (change to your own Earth Engine asset path)
var ASSET_PREFIX = "users/XXX/";

// Export settings
var EXPORT_FOLDER = "GEE_Cnon_crop";  // Export folder name
var EXPORT_SCALE  = 500;              // Output resolution (meters)
var EXPORT_CRS    = "EPSG:4326";      // Output coordinate reference system

// Whether to recalculate alpha and beta parameters (set to true for the first run)
var RECALCULATE_ALPHA_BETA = false;

// ====== Key setting: landcover maximum year ======
var LANDCOVER_MAX_YEAR = 2024;       // Use 2024 landcover as the latest available landcover year
var UI_YEAR_MAX = 2024;              // Maximum year in the UI slider

// ================ Implementation section (usually no need to modify) ================

// Define four global quadrant regions
var regions = [
  ee.Geometry.Rectangle([-180, 0,    0,  90]),  // Northwest quadrant
  ee.Geometry.Rectangle([   0, 0,  180,  90]),  // Northeast quadrant
  ee.Geometry.Rectangle([-180,-90,   0,   0]),  // Southwest quadrant
  ee.Geometry.Rectangle([   0,-90, 180,   0])   // Southeast quadrant
];

// Function for zero-padding numbers
function padNumber(num, size) {
  var s = String(num);
  while (s.length < size) s = "0" + s;
  return s;
}

// -------------- Step 1: Calculate alpha and beta parameters --------------
function calculateAlphaBeta() {
  print("Starting alpha and beta parameter calculation...");

  // Define the daily rainfall erosivity function
  function dailyErosion(image) {
    var precipitation = image.select(['total_precipitation_sum']).multiply(1000);
    var erosionNum = precipitation.where(precipitation.lt(12), 0)
                                  .where(precipitation.gte(12), 1)
                                  .rename('erosion_num');
    var erosion = precipitation.where(precipitation.lt(12), 0).rename('erosion');
    return image.addBands(erosion).addBands(erosionNum);
  }

  // Process data from 1994 to 2023
  var era5Collection = ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
    .filter(ee.Filter.calendarRange(1994, 2023, 'year'))
    .map(dailyErosion)
    .select(['erosion', 'erosion_num']);

  var erosionSum    = era5Collection.select('erosion').sum();
  var erosionNumSum = era5Collection.select('erosion_num').sum();

  // Avoid division by zero
  var erosionNumSumFixed = erosionNumSum.where(erosionNumSum.eq(0), 9999);

  var erosionRatio = erosionSum.divide(erosionNumSumFixed).rename('erosion_ratio');

  var beta  = ee.Image(0.6243).add(ee.Image(27.346).divide(erosionRatio)).rename('beta');
  var alpha = ee.Image(21.239).multiply(beta.pow(-7.3967)).rename('alpha');

  print("Exporting alpha and beta parameters to assets...");

  Export.image.toAsset({
    image: alpha,
    description: 'alpha',
    assetId: ASSET_PREFIX + 'alpha',
    scale: 11132,
    crs: EXPORT_CRS,
    maxPixels: 1e13
  });

  Export.image.toAsset({
    image: beta,
    description: 'beta',
    assetId: ASSET_PREFIX + 'beta',
    scale: 11132,
    crs: EXPORT_CRS,
    maxPixels: 1e13
  });

  print("Alpha and beta parameter calculation finished. Export tasks have been submitted.");
  print("Please wait until the tasks are completed before proceeding to the next step.");
}

// -------------- Step 2: Calculate the WR factor --------------
function calculateWR(year, alphaBetaReady) {
  print("Starting calculation for " + year + " WR factor...");

  if (!alphaBetaReady) {
    print("Error: alpha and beta parameters are not ready!");
    print("Please make sure alpha and beta parameters have been calculated and exported.");
    return null;
  }

  var alpha = ee.Image(ASSET_PREFIX + "alpha");
  var beta  = ee.Image(ASSET_PREFIX + "beta");

  function calculateDailyErosionIndex(image) {
    var precipitation = image.select(['total_precipitation_sum']).multiply(1000);
    var erosion = precipitation.where(precipitation.lt(12), 0).rename('erosion');
    var erosionIndex = erosion.pow(beta).multiply(alpha).rename('erosion_index');
    return erosionIndex.set('system:time_start', image.get('system:time_start'));
  }

  var era5ErosionIndexCollection = ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
    .filter(ee.Filter.calendarRange(year, year, 'year'))
    .map(calculateDailyErosionIndex);

  var yearR = era5ErosionIndexCollection.sum();

  var halfMonthWRDict = {};

  for (var month = 1; month <= 12; month++) {
    var startDateA = ee.Date.fromYMD(year, month, 1);
    var endDateA   = ee.Date.fromYMD(year, month, 16);
    var wrA = era5ErosionIndexCollection.filter(ee.Filter.date(startDateA, endDateA))
      .sum().divide(yearR).rename('wr');

    var startDateB = ee.Date.fromYMD(year, month, 16);
    var endDateB   = (month === 12) ? ee.Date.fromYMD(year + 1, 1, 1)
                                    : ee.Date.fromYMD(year, month + 1, 1);
    var wrB = era5ErosionIndexCollection.filter(ee.Filter.date(startDateB, endDateB))
      .sum().divide(yearR).rename('wr');

    halfMonthWRDict[year + "_WR_" + padNumber(month * 2 - 1, 2)] = wrA;
    halfMonthWRDict[year + "_WR_" + padNumber(month * 2, 2)]     = wrB;
  }

  print(year + " WR factor calculation finished.");
  return {yearR: yearR, wrDict: halfMonthWRDict};
}

// -------------- Step 3: Calculate Cnon-crop --------------
function calculateCnonCrop(year, wrResult) {
  print("Starting calculation for " + year + " Cnon-crop...");

  if (!wrResult) {
    print("Error: WR factor calculation has not been completed!");
    return;
  }

  var lcYear = (year > LANDCOVER_MAX_YEAR) ? LANDCOVER_MAX_YEAR : year;
  if (year !== lcYear) {
    print("Notice: " + year + " landcover uses " + lcYear + " as fallback.");
  }

  var yearR = wrResult.yearR;
  var halfMonthWRDict = wrResult.wrDict;

  var newBandNames = ['B1','B2','B3','B4','B5','B6','B7'];

  function preprocessModis09Image(image) {
    var cloudMask = image.select('state_1km').bitwiseAnd(1 << 10).eq(0);
    var snowMask  = image.select('state_1km').bitwiseAnd(1 << 12).eq(0);
    return image.updateMask(cloudMask).updateMask(snowMask);
  }

  function addBands(image) {
    var NDVI   = image.expression('(b("B2") - b("B1")) / (b("B1") + b("B2"))').rename("NDVI");
    var SWIR32 = image.expression('b("B7") / b("B6")').rename('SWIR32');
    return image.addBands([NDVI, SWIR32]);
  }

  var modis09 = ee.ImageCollection('MODIS/061/MOD09GA')
    .filter(ee.Filter.calendarRange(year, year, 'year'))
    .map(preprocessModis09Image)
    .map(function(img){ return img.select('sur_refl_b.*').rename(newBandNames); })
    .map(addBands);

  var modis43 = ee.ImageCollection('MODIS/061/MCD43A4')
    .filter(ee.Filter.calendarRange(year, year, 'year'))
    .map(function(img){ return img.select('Nadir_Reflectance_Band.*').rename(newBandNames); })
    .map(addBands);

  var landcover = ee.ImageCollection("MODIS/061/MCD12Q1")
    .filter(ee.Filter.calendarRange(lcYear, lcYear, 'year'))
    .first()
    .select('LC_Type5');

  var lcSuffix = (year === lcYear) ? "" : ("_use" + lcYear);
  for (var i = 0; i < regions.length; i++) {
    Export.image.toDrive({
      image: landcover.toInt16(),
      description: 'LC_' + year + lcSuffix + '_region_' + (i + 1),
      folder: 'GEE_LC',
      region: regions[i],
      scale: EXPORT_SCALE,
      crs: EXPORT_CRS,
      maxPixels: 1e13
    });
  }

  var barren = landcover.eq(11);
  var evergreenBroadleafForests = landcover.eq(2);

  function calculatePercentilesInRegion(image, geometry) {
    return image.reduceRegion({
      reducer: ee.Reducer.percentile([10, 90]),
      geometry: geometry,
      scale: 10000,
      maxPixels: 1e13
    });
  }

  function getNdviSwir32Image(modisCollection, startDate, endDate) {
    var ndviImage   = modisCollection.filterDate(startDate, endDate).select('NDVI').median();
    var swir32Image = modisCollection.filterDate(startDate, endDate).select('SWIR32').median();
    return ee.Image.cat([ndviImage, swir32Image]).rename(['NDVI','SWIR32']);
  }

  function fillGapsWithModis09(mcd43Img, mod09Img) {
    var filledNdvi   = mcd43Img.select('NDVI').unmask(mod09Img.select('NDVI'));
    var filledSwir32 = mcd43Img.select('SWIR32').unmask(mod09Img.select('SWIR32'));
    return ee.Image.cat([filledNdvi, filledSwir32]).rename(['NDVI','SWIR32']);
  }

  function calculateFVC(ndviImg, minVal, maxVal) {
    var minImg = ee.Image.constant(ee.Number(minVal));
    var maxImg = ee.Image.constant(ee.Number(maxVal));
    var fvc = ndviImg.subtract(minImg)
                     .divide(maxImg.subtract(minImg))
                     .clamp(0, 1);
    return fvc.toFloat().rename("FVC");
  }

  function calculateNPV(modisImg) {
    var PV_POINT   = [0.814, 0.318];
    var NPV_POINT  = [0.297, 0.490];
    var BS_POINT   = [0.170, 1.02];

    var fractions = modisImg.select(['NDVI','SWIR32'])
      .unmix([PV_POINT, NPV_POINT, BS_POINT], true, true)
      .rename(['PV','NPV','BS']);
    return fractions.select('NPV');
  }

  function calculateCnonCropValue(FVC, NPV, landcover, wr) {
    var SLR_1_2 = FVC.expression(
      "0.44468 * exp(-3.20096 * FVC) - 0.004099 * exp(FVC - f_GD * FVC) + 0.25",
      { 'FVC': FVC, 'f_GD': ee.Number(0.8) }
    );

    var SLR_3_4 = FVC.expression(
      "0.44468 * exp(-3.20096 * FVC) - 0.004099 * exp(FVC - f_NPV * FVC) + 0.25",
      { 'FVC': FVC, 'f_NPV': NPV }
    );

    var SLR_5 = FVC.expression(
      "1 / (1.17647 + 0.86242 * 1.05905 ** (FVC * 100))",
      { 'FVC': FVC }
    );

    var SLR_6 = FVC.expression(
      "1 / (1.25 + 0.78845 * 1.05968 ** (FVC * 100))",
      { 'FVC': FVC }
    );

    var Cnon_crop_1_2 = SLR_1_2.multiply(wr);
    var Cnon_crop_3_4 = SLR_3_4.multiply(wr);
    var Cnon_crop_5   = SLR_5.multiply(wr);
    var Cnon_crop_6   = SLR_6.multiply(wr);

    var Cnon_crop = landcover.where(wr.eq(0), ee.Image(0));

    Cnon_crop = Cnon_crop.where(landcover.eq(1),  Cnon_crop_1_2)
                         .where(landcover.eq(2),  Cnon_crop_1_2)
                         .where(landcover.eq(3),  Cnon_crop_3_4)
                         .where(landcover.eq(4),  Cnon_crop_3_4)
                         .where(landcover.eq(5),  Cnon_crop_5)
                         .where(landcover.eq(6),  Cnon_crop_6);

    var Cnon_crop_Final = Cnon_crop.where(Cnon_crop.eq(1),  1.1)
                                   .where(Cnon_crop.eq(2),  1.2)
                                   .where(Cnon_crop.eq(3),  1.3)
                                   .where(Cnon_crop.eq(4),  1.4)
                                   .where(Cnon_crop.eq(5),  1.5)
                                   .where(Cnon_crop.eq(6),  1.6)
                                   .where(landcover.eq(7),  1)
                                   .where(landcover.eq(8),  1)
                                   .where(landcover.eq(9),  0.01)
                                   .where(landcover.eq(10), 0)
                                   .where(landcover.eq(11), 1)
                                   .where(landcover.eq(0),  0);

    return Cnon_crop_Final.rename("Cnon_crop");
  }

  for (var halfMonthNum = 1; halfMonthNum <= 24; halfMonthNum++) {
    print("Processing half-month " + halfMonthNum + "/24...");

    var startDate = ee.Date.fromYMD(year, 1, 1).advance((halfMonthNum - 1) * 15, 'day');
    var endDate   = startDate.advance(15, 'day');

    var modis09Img = getNdviSwir32Image(modis09, startDate, endDate);
    var modis43Img = getNdviSwir32Image(modis43, startDate, endDate);
    var modisImg   = fillGapsWithModis09(modis43Img, modis09Img);

    var barrenPercentiles = [];
    var forestPercentiles = [];

    for (var r = 0; r < regions.length; r++) {
      var ndviBarren = modisImg.select('NDVI').updateMask(barren);
      var ndviForest = modisImg.select('NDVI').updateMask(evergreenBroadleafForests);
      barrenPercentiles.push(calculatePercentilesInRegion(ndviBarren, regions[r]));
      forestPercentiles.push(calculatePercentilesInRegion(ndviForest, regions[r]));
    }

    var barrenP10List = [];
    var forestP90List = [];
    for (var j = 0; j < barrenPercentiles.length; j++) {
      barrenP10List.push(ee.Dictionary(barrenPercentiles[j]).get('NDVI_p10'));
      forestP90List.push(ee.Dictionary(forestPercentiles[j]).get('NDVI_p90'));
    }

    var barrenP10Mean = ee.Number(ee.List(barrenP10List).reduce(ee.Reducer.mean()));
    var forestP90Mean = ee.Number(ee.List(forestP90List).reduce(ee.Reducer.mean()));

    var FVC = calculateFVC(modisImg.select('NDVI'), barrenP10Mean, forestP90Mean);
    var NPV = calculateNPV(modisImg);

    var wrKey = year + "_WR_" + padNumber(halfMonthNum, 2);
    var wr = halfMonthWRDict[wrKey].select("wr");

    var Cnon_crop = calculateCnonCropValue(FVC, NPV, landcover, wr);

    for (var k = 0; k < regions.length; k++) {
      Export.image.toDrive({
        image: Cnon_crop.multiply(10000).toInt16(),
        description: 'Cnon_crop_' + year + '_' + padNumber(halfMonthNum, 2) + '_region_' + (k + 1),
        folder: EXPORT_FOLDER,
        region: regions[k],
        scale: EXPORT_SCALE,
        crs: EXPORT_CRS,
        maxPixels: 1e13
      });
    }
  }

  print(year + " Cnon-crop calculation finished! All tasks have been submitted.");
}

// --------------- Main program execution (UI) ---------------

var mainPanel = ui.Panel({ style: { width: '300px', padding: '10px' } });

mainPanel.add(ui.Label({
  value: 'Global Cnon-crop Calculation Tool',
  style: { fontSize: '18px', fontWeight: 'bold', margin: '0 0 10px 0', textAlign: 'center' }
}));

var yearRangeLabel = ui.Label('Select start and end years:');

var startYearSlider = ui.Slider({
  min: 2000, max: UI_YEAR_MAX, value: START_YEAR, step: 1,
  onChange: function(v){
    START_YEAR = v;
    if (START_YEAR > END_YEAR) {
      END_YEAR = START_YEAR;
      endYearSlider.setValue(END_YEAR);
    }
  },
  style: { width: '280px' }
});

var endYearSlider = ui.Slider({
  min: 2000, max: UI_YEAR_MAX, value: END_YEAR, step: 1,
  onChange: function(v){
    END_YEAR = v;
    if (END_YEAR < START_YEAR) {
      START_YEAR = END_YEAR;
      startYearSlider.setValue(START_YEAR);
    }
  },
  style: { width: '280px' }
});

var assetLabel = ui.Label('Asset path prefix:');
var assetTextbox = ui.Textbox({
  placeholder: ASSET_PREFIX,
  onChange: function(value) { ASSET_PREFIX = value; },
  style: { width: '280px' }
});

var recalcLabel = ui.Label('Recalculate alpha and beta parameters?');
var recalcCheckbox = ui.Checkbox({
  label: 'Check this for the first run',
  value: RECALCULATE_ALPHA_BETA,
  onChange: function(checked) { RECALCULATE_ALPHA_BETA = checked; }
});

var folderLabel = ui.Label('Export folder:');
var folderTextbox = ui.Textbox({
  placeholder: EXPORT_FOLDER,
  onChange: function(value) { EXPORT_FOLDER = value; },
  style: { width: '280px' }
});

var statusLabel = ui.Label('Ready');

var runButton = ui.Button({
  label: 'Run calculation',
  onClick: function () {
    statusLabel.setValue('Calculation in progress...');

    if (RECALCULATE_ALPHA_BETA) {
      calculateAlphaBeta();
      statusLabel.setValue('Alpha and beta calculation tasks have been submitted. Please wait for completion before running Cnon-crop calculation!');
    } else {
      for (var y = START_YEAR; y <= END_YEAR; y++) {
        var wrResult = calculateWR(y, true);
        if (wrResult) {
          calculateCnonCrop(y, wrResult);
          statusLabel.setValue('Submitted Cnon-crop export tasks for year ' + y);
        } else {
          statusLabel.setValue('WR factor calculation failed: please check whether alpha and beta assets are available.');
          break;
        }
      }
    }
  }
});

var infoText =
  'Instructions:\n\n' +
  '1. For the first run, check "Recalculate alpha and beta parameters" and wait until the asset exports are completed.\n' +
  '2. Set the correct asset path prefix.\n' +
  '3. Select the start and end years (2000-2024) to submit batch calculation and export tasks.\n' +
  '4. Results are exported to Google Drive (Cnon_crop_YYYY_halfmonth_region).\n' +
  '5. The default calculation period is 2001-2024.';

var infoLabel = ui.Label(infoText, { whiteSpace: 'pre', fontSize: '12px', margin: '10px 0 0 0' });

mainPanel.add(yearRangeLabel);
mainPanel.add(ui.Label('Start year'));
mainPanel.add(startYearSlider);
mainPanel.add(ui.Label('End year'));
mainPanel.add(endYearSlider);
mainPanel.add(assetLabel);
mainPanel.add(assetTextbox);
mainPanel.add(folderLabel);
mainPanel.add(folderTextbox);
mainPanel.add(recalcLabel);
mainPanel.add(recalcCheckbox);
mainPanel.add(runButton);
mainPanel.add(statusLabel);
mainPanel.add(infoLabel);

ui.root.widgets().reset([mainPanel]);

print('Global Cnon-crop Calculation Tool loaded. Default calculation period: 2001-2024.');
