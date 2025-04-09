var geometry = ee.Geometry.Polygon(
  [[-111.24557842852906,34.75259470341631],
   [-111.17176403643921,34.75259470341631],
   [-111.17176403643921,34.801944161279316],
   [-111.24557842852906,34.801944161279316],
   [-111.24557842852906,34.75259470341631]]);

/*
Include the following imports (5 entries):

var water : codeAssets/ObservedPoints/waterPoints.shp
var nonWater : codeAssets/ObservedPoints/nonWaterPoints.shp
var studyArea : codeAssests/SouthwestWater_studyArea.shp
var states : codeAssets/Regions_USGS/GU_StateOrTerritory.shp
var geometry : Polygon 4 verticies 
	Coordinates: 0: [-111.24557842852906,34.75259470341631]
        1: [-111.17176403643921,34.75259470341631]
        2: [-111.17176403643921,34.801944161279316]
        3: [-111.24557842852906,34.801944161279316]
        4: [-111.24557842852906,34.75259470341631]
*/

//---------------------------------------------------------------
// File: S1_classificationAccuracyAssessment
// Name: SWIFT (Surface Water Identification and Forecasting Tool)
// Date: August 12, 2021
// Contact: Kyle Paulekas, kjpaulekas@gmail.com
// -----------------
// Description: Model to classify and identify surface water bodies in Landsat 8 and Sentinel-2 imagery
//              and test the accuracy using observed non-water and water points. 
//
// Usage: This code is scripted to run in Google Earth Engine to 
//        classify water and non-water image pixels in the study region 
//        (AOI). Water is classified using a Random Forest Classification scheme using 303 observed points
//        to train the model. This will assess the accuracy of the methods used to create the time series and 
//        surface water monitoring tool.
//        
// Parameters:
//    In: Water and Non-Water point observations for 2018-01-28 (training and testing data),
//        Modified Normalized Difference Water Index (MNDWI), Automated Water Extraction Index 
//        corrected for shadows (AWEIsh), Tassled-Cap Wetness (TWC), and Normalized Difference 
//        Vegetative Index (NDVI).
//   
//    Out: Total area of water within the area of interest (AOI), overall accuracy, Kappa accuracy,
//          and confusion matrices for the method, assessed using 20% of the validation data set aside for testing.
// ---------------------------------------------------------------
// 
// Import records:
// var L8: ImageCollection "USGS Landsat 8 Surface Reflectance Tier 1"
// var S2: ImageCollection "ESA Sentinel-2 Surface Reflectance Level 1-C"
// var S1: ImageCollection "ESA Sentinel-1 C-band Synthetic Aperture Radar Ground Range Detected, log scaling"
// var HAND: ImageCollection "MERIT Hydro: global hydrography datasets, Height Above Nearest Drainage band"
// var ws: ImageCollection "CFSV2: NCEP Climate Forecast System Version 2, 6-Hourly Products, used for masking windy pixels"
// var studyArea: FeatureCollection "Area of Study, northern Arizona"
// var geometry: Polygon "Geometry used for image export and small-scale analyses"
// ===================================================================================================================

/** ----------Develop training data using digitized pond extents and selected dry points---------- **/
var waterPts = ee.FeatureCollection(water.map(function(p){
  return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':1});
})); 
var dryPts = ee.FeatureCollection(nonWater.map(function(p){
  return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':0});
})); 

// merge water and non-water points into training data
var points = waterPts.merge(dryPts);
// Reduce points to an image with water band
var pointsIm = points.reduceToImage(['water'],ee.Reducer.sum());

/** ----------Define temporal coverage and Area of Interest (AOI)---------- **/
var start_date = '2018-01-20';
var end_date = '2018-02-04';
var AOI = points;

/** ----------Pre-process Sentinel-1 imagery---------- **/
// Import scripts from Mullissa et al. (2021)
var wrapper = require('users/adugnagirma/gee_s1_ard:wrapper');
var helper = require('users/adugnagirma/gee_s1_ard:utilities');

// Define parameters
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

// Preprocess the image collection
var S1_preprocess = wrapper.s1_preproc(parameter);
var S1 = S1_preprocess[0];
S1_preprocess = S1_preprocess[1];
      
/** ----------Filter pixels where wind > 12 km/h---------- **/
// Code adapted from Gulacsi and Kovacs (2020): https://www.mdpi.com/2072-4292/12/10/1614

// Get a list of the dates
var datesList = S1_preprocess.aggregate_array('system:time_start');

// Get data from CFSV2: NCEP Climate Forecast System Version 2, 6-Hourly Products
// for the wind mask to eliminate surface roughening by wind 
var ws = ee.List(datesList).map(function (date) {
  var wx = ee.ImageCollection('NOAA/CFSV2/FOR6H').filterDate([start_date,end_date]);
  var vWind = wx.select(['v-component_of_wind_height_above_ground']);
  var a = vWind.max();
  var uWind = wx.select(['u-component_of_wind_height_above_ground']);
  var b = uWind.max();
  a = a.pow(2);
  b = b.pow(2);
  var ab = a.add(b);
  var ws = ab.sqrt();
  ws = ws.multiply(3.6);
  return ws.rename('windy').set('date', date);
});
// Update mask to exlude areas where where the wind speed is >= 12 m/s
var windMask = function (image) {
  var mask = ee.Image(0).where(image.select('windy').lt(12.0), 1);
  return image.updateMask(mask);
};
// Apply wind mask to S1 pre-processed collection
S1_preprocess.map(windMask);

/** ----------Mosaic image collection to increase spatial coverage---------- **/
var S1_mosaic = S1_preprocess.mosaic();

/** ----------Random Forest Classification---------- **/
// Select bands to use as predictors in classification
var bands = ['VV','VH','angle'];
//Make training data by 'overlaying' the points on the first image
var observedPoints = S1_mosaic.sampleRegions({
  collection: points, 
  properties: ['water'], 
  scale: 10
}).randomColumn();

// Randomly split the samples to set some aside for testing the model's accuracy
// using the "random" column. Roughly 80% for training, 20% for testing.
var split = 0.8;
var training = observedPoints.filter(ee.Filter.lt('random', split));
var testing = observedPoints.filter(ee.Filter.gte('random', split));

// Run the RF model using 300 trees and 3 predictors. 
// Train using bands and land cover property and pull the land cover property from classes
var classifier = ee.Classifier.smileRandomForest(500).train({ 
  features: training,
  classProperty: 'water',
  inputProperties: bands
});

// Apply the trained classifier to the image
var classified = S1_mosaic.select(bands).classify(classifier);

/** ----------Apply a boxcar smoothing kernel---------- **/
// Define a boxcar or low-pass kernel.
var boxcar = ee.Kernel.square({
  radius: 5, units: 'pixels', normalize: true
});

// Smooth the image by convolving with the boxcar kernel.
var smooth = classified.select('classification').convolve(boxcar);
var waterIm = smooth.gt(0.97);

/** ----------Filter pixels using the Height Above Nearest Drainage (HAND)----------**/
// Load MERIT Hydro Dataset HAND ('hnd') band
var HAND = ee.Image("MERIT/Hydro/v1_0_1").select('hnd');
// Mask pixels with HAND > 10 m
var HANDmask = HAND.lt(10);
var water_masked = waterIm.updateMask(HANDmask);

/** ----------Accuracy Assessment---------- **/
// Print Overall Accuracy, Confusion Matrix, and Kappa for Testing Points
var validation = testing.classify(classifier);
var testAccuracy = validation.errorMatrix('water', 'classification');
print('Validation Error Matrix RF: ', testAccuracy);
print('Validation Overall Accuracy RF: ', testAccuracy.accuracy());
var kappa1 = testAccuracy.kappa();
print('Validation Kappa', kappa1);

/** ----------Add layers to map---------- **/
// Create outline of Arizona
var AZ = states.filterMetadata('State_Name','equals','Arizona');
var AZOutline = ee.Image().byte().paint({
  featureCollection: AZ,
  color: 1,
  width: 3
});
Map.addLayer(HAND,{},'HAND',false);
Map.addLayer(AZOutline,{color:'black'},'Arizona State Outline');
Map.addLayer(studyArea,{color:'green',opacity: 0.8},'Study Area',false);
Map.addLayer(water,{color:'blue'},'Water Validation Points');
Map.addLayer(nonWater,{color:'brown'},'Non-Water Validation Points');
Map.addLayer(S1_mosaic.select(['VV','VH']).clip(geometry),{},'S1_mosaic',false);
Map.addLayer(water_masked.clip(geometry),{min:0,max:1},'water, HAND-masked');
Map.centerObject(geometry,13);

/** ----------Optional: export pre-processed and classified images in "geometry" polygon---------- **/
var S1_classified = water_masked.clip(geometry);
var S1_preprocessed = S1_mosaic.select(['VV','VH']).clip(geometry);
Export.image.toDrive({
  image: S1_classified,
  description: "S1_classified",
  folder: 'NASA_DEVELOP',
  scale: 10,
  maxPixels: 1e10
});
Export.image.toDrive({
  image: S1_preprocessed,
  description: "S1_preprocessed",
  folder: 'NASA_DEVELOP',
  scale: 10,
  maxPixels: 1e10
});