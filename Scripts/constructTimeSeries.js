/*
Include the follwing imports (5 Entries):

var States : codeAssets/Regions_USGS/GU_StateOrTerritory.shp
var studyArea : codeAssets/SouthwestWater_StudyArea.shp
var allotment_USFS : codeAssets/Allotment_SWregion.shp
var water : codeAssets/ObservedPoints/waterPoints.shp
var nonWater : codeAssets/ObservedPoints/nonWaterPoints.shp
*/

// ---------------------------------------------------------------
// File: constructTimeSeries
// Name: SWIFT (Surface Water Identification and Forecasting Tool)
// Date: August 8, 2021
// Contact: Kyle Paulekas, kjpaulekas@gmail.com
// ---------------------------------------------------------------
// Description: Workflow to estimate the total average weekly surface
//              water extent in northern Arizona using: Landsat 8 and
//              Sentinel-2 Surface Reflectance products and Sentinel-1
//              Ground Range Detected (GRD) products.
//
// Usage: This code is scripted to run in Google Earth Engine to
//        classify water and non-water image pixels in the study region
//        (ROI) and for grazing allotments in Arizona. Water is classified using
//        a Random Forest Classification scheme using 303 observed points
//        to train the model. This will allow users to create historical
//        time series for water availability in the region.
//
// Parameters:
//    In: Water and Non-Water point observations for 2018-01-28 (training and testing data),
//        Modified Normalized Difference Water Index (MNDWI), Automated Water Extraction Index
//        corrected for shadows (AWEIsh), Tassled-Cap Wetness (TWC), and Normalized Difference
//        Vegetative Index (NDVI) (optical imagery classification), 'VV', 'VH', and 'angle'
//        bands (radar imagery classification).
//
//    Out: Total area of water within the region of interest (ROI) and in each grazing allotment
//         in Arizona.
// ---------------------------------------------------------------
//
// Import records:
// var L8: ImageCollection "USGS Landsat 8 Surface Reflectance Tier 1"
// var S2: ImageCollection "ESA Sentinel-2 Surface Reflectance Level 1-C"
// var S1: ImageCollection "ESA Sentinel-1 C-band Synthetic Aperture Radar Ground Range Detected, log scaling"
// var HAND: ImageCollection "MERIT Hydro: global hydrography datasets, Height Above Nearest Drainage band"
// var ws: ImageCollection "CFSV2: NCEP Climate Forecast System Version 2, 6-Hourly Products, used for masking windy pixels"
// var studyArea: Table "2021Sum_ID_SouthwestWater_StudyArea"
// var states: FeatureCollection "GU Federal State or Territory Borders"
// var allotments_USFS: FeatureCollection "USFS Grazing Allotments"
// var water: Table "water points digitized using high-resolution imagery in January 2018, used for training"
// var nonWater: Table "non-water points digitized using high-resolution imagery in January 2018, used for training"
// ===================================================================================================================

//// NOTES: Change lines 47-50 to change date range and Area of Interest (AOI)
////        Change lines 412-413 and 451-453 to change export settings
////        for the water extent in the AOI and grazing allotments, respectively.

/** ----------Define date range and Area of Interest (AOI)----------**/
var start_date = ee.Date('2013-04-01'); 
var end_date = start_date.advance(2,'week');
var AOI = studyArea;

/** ----------Filter assets to Arizona----------**/
// Arizona state borders
var AZ = states.filterMetadata('State_Name','equals','Arizona');
// Grazing Allotments in Arizona (USFS)
var allotments = allotments_USFS.filterBounds(AZ.geometry());

/** ----------Define visualization parameters---------- **/
var waterVis = {palette: ['white','blue'], min:0, max: 1};

/** ----------Develop training data using digitized "water" and "nonWater" points---------- **/
var waterPoints = ee.FeatureCollection(water.map(function(p){
  return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':1});
})); 
var dryPoints = ee.FeatureCollection(nonWater.map(function(p){
  return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':0});
})); 

// merge water and non-water points into training data
var points = waterPoints.merge(dryPoints);

/** ----------Develop classifiers---------- **/
// Landsat 8 image quality masking
function L8QAMask(image){
  // Bits 3 and 5 are cloud shadow and cloud, respectively.
  var cloudShadowBitMask = 1 << 3;
  var cloudsBitMask = 1 << 5;
  // Get the pixel QA band.
  var qa = image.select('QA_PIXEL');
  //Both flags should be set to zero, indicating clear conditions.
  var mask = (
      qa.bitwiseAnd(cloudShadowBitMask).eq(0)
      .and(qa.bitwiseAnd(cloudsBitMask).eq(0))
  );
  //Return the masked image, scaled to reflectance, without the QA bands.
  return (
      image.updateMask(mask).divide(10000)
      .select("SR_B[0-9]*")
      .copyProperties(image, ["system:time_start"])
  );
}
// Sentinel-2 image quality masking
function S2QAMask(image){
  var QA60 = image.select(['QA60']);
  return image.updateMask(QA60.lt(1));
}
// harmonize imagery
function harmonize(S2im){
    var landsatLike = S2im.multiply(GAIN).add(BIAS);
    return landsatLike.copyProperties(S2im,["system:time_start"]);
}

// Define L8 training collection
var L8training = (ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .filterBounds(water)
  .filterDate('2018-01-25', '2018-02-07')
  .filter(ee.Filter.lt('CLOUD_COVER', 10))
  .map(L8QAMask)
  .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
  ['blue','green','red','NIR','SWIR1','SWIR2'])
);

// Sentinel-2 band pass adjustment coefficients
// Coefficients from https://www.sciencedirect.com/science/article/pii/S0034425718304139
var GAIN = ee.Image.constant([0.9778, 1.0053, 0.9765, 0.9983, 0.9987, 1.003]);
var BIAS = ee.Image.constant([-0.00411, -0.00093, 0.00094, -0.0001, -0.0015, -0.0012]);
// Define S2 training collection
var S2training = (ee.ImageCollection('COPERNICUS/S2')
  .filterBounds(water)
  .filterDate('2018-01-25', '2018-02-07')
  .filter(ee.Filter.lt('CLOUD_COVERAGE_ASSESSMENT', 10))
  .map(S2QAMask)
  .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
  ['blue','green','red','NIR','SWIR1','SWIR2'])
  .map(harmonize)
);
// Merge optical training collections
var L8S2training = L8training.merge(S2training);

// Function to calculate water indices used as predictors in the RF classification
// Result is a multi band image water detection indices
function waterMapping(im){
  
  // Calculate different indices to threshold
  // Modified Normalized Difference Water index
  var MNDWI = im.normalizedDifference(["green","SWIR1"]).rename('MNDWI').toFloat();
    
  // Automated Water Extraction Index (shadow) 
  var AWEIsh = im.expression(
      "b+2.5*g-1.5*(n+s)-0.25*w",
      {
          "b": im.select("blue"),
          "g": im.select("green"),
          "n": im.select("NIR"),
          "s": im.select("SWIR1"),
          "w": im.select("SWIR2")
      }).rename('AWEIsh').toFloat();
    
  // Tassled Cap Wetness index
  var TWC = im.expression(
      '0.1511 * b + 0.1973 * g + 0.3283 * r + 0.3407 * n + -0.7117 * s1 + -0.4559 * s2',
      {
          'b': im.select('blue').toFloat(),
          'g': im.select('green').toFloat(),
          'r': im.select('red').toFloat(),
          'n': im.select('NIR').toFloat(),
          's1': im.select('SWIR1').toFloat(),
          's2': im.select('SWIR2').toFloat(),
      }).rename('TWC').toFloat();
        
  // Normalized Difference Vegetation Index
  var NDVI = im.normalizedDifference(["NIR","red"]).rename('NDVI').toFloat();

  // Add bands to image
  var im_Bands = im.addBands([MNDWI,AWEIsh,TWC,NDVI]);
    
  // Return image with only the selected bands
  return im_Bands.select(['MNDWI','AWEIsh','TWC','NDVI']);
}

// Apply waterMapping function to optical collection
var L8S2training_ind = L8S2training.map(waterMapping);
// Mosaic images to increase spatial coverage
var L8S2training_ind_mosaic = L8S2training_ind.mosaic();
// Define bands to use for training
var optical_bands = ['MNDWI','AWEIsh','TWC','NDVI'];

// Make optical training data by 'overlaying' the points onto the image
var optical_training = L8S2training_ind_mosaic.select(optical_bands).sampleRegions({
  collection: points, 
  properties: ['water'],
  projection: L8S2training_ind_mosaic.projection(),
  scale: 30
}).randomColumn();

// Define the RF model using 500 trees 
var optical_classifier = ee.Classifier.smileRandomForest(500).train({ 
  features: optical_training,
  classProperty: 'water',
  inputProperties: optical_bands
});

// Pre-process Sentinel-1 imagery
// Import scripts from Mullissa et al. (2021)
var wrapper = require('users/adugnagirma/gee_s1_ard:wrapper');
var helper = require('users/adugnagirma/gee_s1_ard:utilities');

// Define parameters
var parameter = {//1. Data Selection
              START_DATE: '2018-01-25',
              STOP_DATE: '2018-02-07',
              POLARIZATION:'VVVH',
              ORBIT : 'BOTH',
              //GEOMETRY: geometry, //uncomment if interactively selecting a region of interest
              GEOMETRY: water,
              //2. Additional Border noise correction
              APPLY_ADDITIONAL_BORDER_NOISE_CORRECTION: true,
              //3.Speckle filter
              APPLY_SPECKLE_FILTERING: true,
              SPECKLE_FILTER_FRAMEWORK: 'MULTI',
              SPECKLE_FILTER: 'LEE',
              SPECKLE_FILTER_KERNEL_SIZE: 9,
              SPECKLE_FILTER_NR_OF_IMAGES: 10,
              //4. Radiometric terrain normalization
              APPLY_TERRAIN_FLATTENING: true,
              DEM: ee.Image('USGS/SRTMGL1_003'),
              TERRAIN_FLATTENING_MODEL: 'VOLUME',
              TERRAIN_FLATTENING_ADDITIONAL_LAYOVER_SHADOW_BUFFER: 0,
              //5. Output
              FORMAT : 'DB',
              CLIP_TO_ROI: false,
              SAVE_ASSETS: false
};

// Preprocess the image collection
var S1_preprocess = wrapper.s1_preproc(parameter);
var S1 = S1_preprocess[0];
S1_preprocess = S1_preprocess[1];
// Mosaic image collection to increase spatial coverage
var S1_mosaic = S1_preprocess.mosaic();
//Make training data by 'overlaying' the points onto the image
var S1_training = S1_mosaic.sampleRegions({
  collection: points, 
  properties: ['water'], 
  scale: 10
}).randomColumn();

// Define bands to use in classification
var S1_bands = ['VV','VH','angle'];
// Define the RF model using 500 trees 
var S1_classifier = ee.Classifier.smileRandomForest(500).train({ 
  features: S1_training,
  classProperty: 'water',
  inputProperties: S1_bands
});

/** ----------Define image collections and classify---------- **/
/* Optical imagery */
var L8 = (ee.ImageCollection('LANDSAT/LC08/C02/T1_L2') // Landsat 8
  .filterBounds(water)
  .filterDate(start_date, end_date)
  .filter(ee.Filter.calendarRange(3,11,'month'))
  .filter(ee.Filter.lt('CLOUD_COVER', 10))
  .map(L8QAMask)
  .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
 ['blue','green','red','NIR','SWIR1','SWIR2'])
 );
var S2 = (ee.ImageCollection('COPERNICUS/S2') // Sentinel-2
  .filterBounds(water)
  .filterDate(start_date, end_date)
  .filter(ee.Filter.calendarRange(3,11,'month'))
  .filter(ee.Filter.lt('CLOUD_COVERAGE_ASSESSMENT', 10))
  .map(S2QAMask)
  .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
  ['blue','green','red','NIR','SWIR1','SWIR2'])
  .map(harmonize)
);
// Merge image collections
var L8S2 = L8.merge(S2);
// Apply water detection band indices
var L8S2_ind = L8S2.map(waterMapping);
// Classify images in collection using the pre-defined classifier
var L8S2_classified = L8S2_ind.map(function(im){return im.classify(optical_classifier)});

/* Radar imagery */
// Define S-1 parameters
var parameter = {//1. Data Selection
              START_DATE: start_date,
              STOP_DATE: end_date,
              POLARIZATION:'VVVH',
              ORBIT : 'BOTH',
              //GEOMETRY: geometry, //uncomment if interactively selecting a region of interest
              GEOMETRY: AOI,
              //2. Additional Border noise correction
              APPLY_ADDITIONAL_BORDER_NOISE_CORRECTION: true,
              //3.Speckle filter
              APPLY_SPECKLE_FILTERING: true,
              SPECKLE_FILTER_FRAMEWORK: 'MULTI',
              SPECKLE_FILTER: 'LEE',
              SPECKLE_FILTER_KERNEL_SIZE: 9,
              SPECKLE_FILTER_NR_OF_IMAGES: 10,
              //4. Radiometric terrain normalization
              APPLY_TERRAIN_FLATTENING: true,
              DEM: ee.Image('USGS/SRTMGL1_003'),
              TERRAIN_FLATTENING_MODEL: 'VOLUME',
              TERRAIN_FLATTENING_ADDITIONAL_LAYOVER_SHADOW_BUFFER: 0,
              //5. Output
              FORMAT : 'DB',
              CLIP_TO_ROI: false,
              SAVE_ASSETS: false
};

// Preprocess the S-1 image collection 
// using the published workflow from Mullisa et al. (2021): 
// https://www.mdpi.com/2072-4292/13/10/1954
var S1_preprocess = wrapper.s1_preproc(parameter);
var S1 = S1_preprocess[0];
S1_preprocess = S1_preprocess[1];
// Apply the pre-defined classifier 
var S1_cf = S1_preprocess.map(function(im){return im.classify(S1_classifier)});

// Apply a boxcar smoothing kernel and wind filter to reduce the 
// impact of variations in surface roughness. 
// Define a boxcar or low-pass kernel
var boxcar = ee.Kernel.square({
  radius: 5, units: 'pixels', normalize: true
});

// Apply a wind mask for pixels with a mean wind speed > 12 km/h near the time of image capture
// Code adapted from Gulacsi and Kovacs (2020): https://www.mdpi.com/2072-4292/12/10/1614
// Get data from CFSV2: NCEP Climate Forecast System Version 2, 6-Hourly Products
// for the wind mask to eliminate surface roughening by wind 
function windMask(im){
  var wx = ee.ImageCollection('NOAA/CFSV2/FOR6H').filterDate(start_date,end_date);
  var vWind = wx.select(['v-component_of_wind_height_above_ground']);
  var a = vWind.max();
  var uWind = wx.select(['u-component_of_wind_height_above_ground']);
  var b = uWind.max();
  a = a.pow(2);
  b = b.pow(2);
  var ab = a.add(b);
  var ws = ab.sqrt();
  ws = ws.multiply(3.6).rename('windy');
  var mask = ws.select('windy').lt(12.0);
  return im.updateMask(mask);
}
// Smooth the image collection and apply a wind mask for wind speeds > 12 km/h
var S1_classified = S1_cf.map(function(im){return im.select('classification')
  .convolve(boxcar).gt(0.97)})
  .map(windMask);

/** ----------Mosaic classified images by date---------- **/
// Merge collections
var collection = L8S2_classified.merge(S1_classified);

// Create image mosaics for each week in the collection
function mosaicByDate(date) {
  var composite = collection.median()
      .set('system:time_start', date.millis(), 'dateYMD', date.format('YYYY-MM-dd'),
      'numbImages', collection.size());
  return composite;
}

// Iterate over the range to make a new list, and then cast the list to an imagecollection
var monthDifference = ee.Date(start_date).advance(1, 'month').millis().subtract(ee.Date(start_date).millis());
var listMap = ee.List.sequence(ee.Date(start_date).millis(), ee.Date(end_date).millis(), monthDifference);
var mosaics = ee.ImageCollection.fromImages(listMap.map(function(dateMillis){
  var date = ee.Date(dateMillis);
  return mosaicByDate(date);
}));
// Print number of image mosaics
print('Number of Image Mosaics:',mosaics.size());
// Clip images to AOI
mosaics.map(function (im){return im.clip(AOI)});

/** ----------Define water where classification = 1---------- **/
// Function to mask pixels with classification < 1
// Result is a masked image
function maskNonWater(im){
  return im.updateMask(im.select('classification').lt(1));
}
// Apply function to image mosaics
var water_collection = mosaics.map(maskNonWater);

/** ----------Filter pixels using the Height Above Nearest Drainage (HAND)----------**/
// Load MERIT Hydro Dataset HAND ('hnd') band
var HAND = ee.Image("MERIT/Hydro/v1_0_1").select('hnd');
// Mask pixels with HAND > 10 m
var HANDmask = HAND.lt(10);
var water_masked = water_collection.map(function(im){return im.updateMask(HANDmask)});

/** ----------Calculate water area in AOI---------- **/
function calculateWaterArea_AOI(im){
  
  // Calculate area of water (m^2)
  var waterArea = im
    .multiply(ee.Image.pixelArea().divide(1e6))
    .rename('waterArea'); 
    
  // Add area of water as a band
  im = im.addBands(waterArea);

  // Calculate area 
  var area = waterArea.reduceRegion({
    reducer: ee.Reducer.sum(), 
    geometry: AOI, 
    scale: 30,
    maxPixels: 1e13
  }).get('waterArea');
  
  // Reformat image date for export
  var date = ee.Date(im.get('system:time_start')).format('YYYY-MM-dd');  
    
  return im.set({'area':area,'date':date});
  
}
// Apply function to HAND-masked image collection
var waterArea_AOI = water_masked.map(calculateWaterArea_AOI);

// Export results as CSV
// Export.table.toDrive({
//   collection: waterArea_AOI,
//   description: 'waterAreaAOI',
//   folder: 'EarthEngine',
//   selectors:(['date','area'])
// });

/** ----------Calculate water area in allotments---------- **/
function calculateWaterArea_allotments(feature){

  var areaTimeSeries = water_masked.map(function(im){
      
    // Calculate area of water (m^2)
    var waterArea = im
      .multiply(ee.Image.pixelArea().divide(1e6))
      .rename('waterArea'); 
    
    // Add area of water as a band
    im = im.addBands(waterArea);
  
    // calculate area 
    var area = waterArea.reduceRegion({
      reducer: ee.Reducer.sum(), 
      geometry: feature.geometry(), 
      scale: 30,
      maxPixels: 1e10
    }).get('waterArea');
      
    return ee.Feature(null,{'area':area,'date':ee.Date(im.get('system:time_start')).format('YYYY-MM-dd')});
  
  });
    
  return feature.set({'area':areaTimeSeries.aggregate_array('area'),
    'date':areaTimeSeries.aggregate_array('date')});
}
// Apply function to all grazing allotments in AOI
var waterArea_allotments = allotments.map(calculateWaterArea_allotments);

// Export results as CSV
Export.table.toDrive({
  collection: waterArea_allotments,
  description: 'waterAreaAllotments',
  folder: 'EarthEngine',
  selectors:(['ALLOTMENT_','date','area'])
});

/** ----------Add layers to map---------- **/
// Create outline of Arizona
var AZOutline = ee.Image().byte().paint({
  featureCollection: AZ,
  color: 1,
  width: 3
});
Map.addLayer(water_masked.first().clip(AOI),waterVis,'water_masked',false);
Map.addLayer(AZOutline,{color:'black'},'Arizona State Outline');
Map.addLayer(studyArea,{color:'green',opacity:0.8},'ROI',false);
Map.centerObject(water,7);