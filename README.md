# Global Cnon-crop Calculation Tool for Google Earth Engine

This repository provides a Google Earth Engine JavaScript script for calculating global Cnon-crop from 2001 to 2024.

The script integrates ERA5-Land precipitation data, MODIS surface reflectance products, and MODIS land cover data to generate half-monthly global Cnon-crop outputs. The results are exported by four global quadrants to reduce export size and improve task stability in Google Earth Engine.

## Overview

Cnon-crop is a vegetation-cover-related parameter for non-cropland surfaces. It can be used in soil erosion, land surface process, and vegetation protection studies.

This script was designed for use in the Google Earth Engine Code Editor. It supports batch-year processing and exports half-monthly Cnon-crop results for each year.

## Main Features

- Calculates global Cnon-crop from 2001 to 2024.
- Supports batch processing for multiple years.
- Uses ERA5-Land daily precipitation for rainfall erosivity-related calculation.
- Uses MODIS surface reflectance data to calculate NDVI and SWIR-based indicators.
- Uses MODIS land cover data to assign land-cover-specific Cnon-crop values.
- Calculates alpha and beta parameters based on the 1994-2023 historical period.
- Calculates half-monthly WR factors.
- Calculates FVC and NPV using MODIS reflectance data.
- Exports results by four global quadrants.
- Exports Cnon-crop outputs to Google Drive.

## Data Sources

The script uses the following Google Earth Engine datasets:

| Dataset | GEE ID | Purpose |
|---|---|---|
| ERA5-Land Daily Aggregated | `ECMWF/ERA5_LAND/DAILY_AGGR` | Daily precipitation and rainfall erosivity calculation |
| MODIS Surface Reflectance | `MODIS/061/MOD09GA` | NDVI and SWIR-based index calculation |
| MODIS Nadir BRDF-Adjusted Reflectance | `MODIS/061/MCD43A4` | Primary NDVI and SWIR-based index calculation |
| MODIS Land Cover | `MODIS/061/MCD12Q1` | Land cover classification and Cnon-crop assignment |

## Repository Structure

```text
Global-Cnon-crop-GEE/
├── global_cnon_crop_gee_2001_2024.js
├── README.md
└── LICENSE
```

## Main Script

```text
  Global_Cnon_crop_gee_2001_2024.js
```

This is the main Google Earth Engine JavaScript script. It can be copied directly into the Google Earth Engine Code Editor and executed.

## Key Parameters

The main user-configurable parameters are located near the top of the script.

```javascript
var START_YEAR = 2001;
var END_YEAR   = 2024;

var ASSET_PREFIX = "users/XXX/";

var EXPORT_FOLDER = "GEE_Cnon_crop";
var EXPORT_SCALE  = 500;
var EXPORT_CRS    = "EPSG:4326";

var RECALCULATE_ALPHA_BETA = false;

var LANDCOVER_MAX_YEAR = 2024;
var UI_YEAR_MAX = 2024;
```

## Parameter Description

| Parameter | Description |
|---|---|
| `START_YEAR` | First year for batch calculation |
| `END_YEAR` | Last year for batch calculation |
| `ASSET_PREFIX` | User's Google Earth Engine asset path prefix for alpha and beta assets |
| `EXPORT_FOLDER` | Google Drive folder for exported Cnon-crop results |
| `EXPORT_SCALE` | Export spatial resolution in meters |
| `EXPORT_CRS` | Output coordinate reference system |
| `RECALCULATE_ALPHA_BETA` | Whether to recalculate and export alpha and beta parameters |
| `LANDCOVER_MAX_YEAR` | Latest available land cover year used by the script |
| `UI_YEAR_MAX` | Maximum year shown in the GEE user interface slider |

## How to Use

### Step 1. Open Google Earth Engine

Open the Google Earth Engine Code Editor and create a new script.

### Step 2. Copy the Script

Copy all code from:

```text
Global_Cnon_crop_gee.js
```

into the GEE Code Editor.

### Step 3. Set Your Asset Path

Modify the asset path prefix:

```javascript
var ASSET_PREFIX = "users/your_username/";
```

Make sure the path matches your own Google Earth Engine asset directory.

### Step 4. First Run: Calculate Alpha and Beta

For the first run, set:

```javascript
var RECALCULATE_ALPHA_BETA = true;
```

Then run the script and start the export tasks for `alpha` and `beta`.

After the export tasks are completed, set:

```javascript
var RECALCULATE_ALPHA_BETA = false;
```

### Step 5. Run Cnon-crop Calculation

Select the target start and end years in the GEE user interface panel, then click the calculation button.

The script will submit export tasks for each half-month period and each global quadrant.

## Output Naming

### Cnon-crop outputs

The Cnon-crop outputs are exported to Google Drive using the following naming format:

```text
Cnon_crop_YYYY_HH_region_R
```

where:

| Field | Meaning |
|---|---|
| `YYYY` | Target year |
| `HH` | Half-month period number, from 01 to 24 |
| `R` | Region number, from 1 to 4 |

Example:

```text
Cnon_crop_2024_01_region_1
```

### Land Cover Outputs

Land cover outputs are exported using the following naming format:

```text
LC_YYYY_region_R
```

Example:

```text
LC_2024_region_1
```

## Global Region Partition

The script divides the globe into four quadrants:

| Region | Longitude Range | Latitude Range |
|---|---|---|
| Region 1 | -180 to 0 | 0 to 90 |
| Region 2 | 0 to 180 | 0 to 90 |
| Region 3 | -180 to 0 | -90 to 0 |
| Region 4 | 0 to 180 | -90 to 0 |

## Output Scaling

The final Cnon-crop image is multiplied by 10000 and exported as `Int16`.

This means that users should divide the exported raster values by 10000 to obtain the original Cnon-crop values.

For example:

```text
Stored value = 2500
Actual Cnon-crop value = 2500 / 10000 = 0.25
```

## Notes

- The script may generate many export tasks, especially when running multiple years.
- Google Earth Engine export tasks need to be started manually in the Tasks panel.
- The alpha and beta parameters only need to be generated once unless the parameter calculation period or method is changed.
- The default calculation period is 2001-2024.
- The alpha and beta calibration period is 1994-2023.
- The output Cnon-crop is multiplied by 10000 and exported as `Int16` to reduce file size.

## Recommended Citation

If this script is used in academic work, please cite the corresponding datasets and describe the Cnon-crop calculation method used in your manuscript, thesis, or technical report.

## License

Please add a license before publishing this repository publicly.

For open academic use, the MIT License is commonly used. If you want to restrict commercial use, consider a Creative Commons non-commercial license instead.

