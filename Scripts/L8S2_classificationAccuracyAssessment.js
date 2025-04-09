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

// ---------------------------------------------------------------
// File: L8S2classification
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
// var studyArea: FeatureCollection "Area of Study, northern Arizona"
// var geometry: Polygon "Geometry used for image export and small-scale analyses"
// ===================================================================================================================

/** ----------Define temporal and Area of Interest (AOI)---------- **/
var start_date = '2018-01-21';
var end_date = '2018-02-07';
var AOI = geometry;

/** ----------Develop training data using digitized pond extents and selected dry points---------- **/
var waterPts = ee.FeatureCollection(water.map(function(p){
  return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':1});
})); 
var dryPts = ee.FeatureCollection(nonWater.map(function(p){
  return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':0});
})); 

// merge water and non-water points into training data
var points = waterPts.merge(dryPts);

/** ----------Pre-process optical imagery---------- **/
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

// Define L8 imagery collection
var L8 = (ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .filterBounds(AOI)
  .filterDate(start_date, end_date)
  .filter(ee.Filter.lt('CLOUD_COVER', 10))
  .map(L8QAMask)
  .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
  ['blue','green','red','NIR','SWIR1','SWIR2'])
);

// Sentinel-2 band pass adjustment coefficients
// Coefficients from https://www.sciencedirect.com/science/article/pii/S0034425718304139
var GAIN = ee.Image.constant([0.9778, 1.0053, 0.9765, 0.9983, 0.9987, 1.003]);
var BIAS = ee.Image.constant([-0.00411, -0.00093, 0.00094, -0.0001, -0.0015, -0.0012]);
// Define S2 imagery collection
var S2 = (ee.ImageCollection('COPERNICUS/S2')
  .filterBounds(AOI)
  .filterDate(start_date, end_date)
  .filter(ee.Filter.lt('CLOUD_COVERAGE_ASSESSMENT', 10))
  .map(S2QAMask)
  .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
  ['blue','green','red','NIR','SWIR1','SWIR2'])
  .map(harmonize)
);

// Merge collections
var collection = L8.merge(S2);

// Print number of images in collection
print('Number of images in collection:',collection.size());

/** ----------Add water indices to image---------- **/
// Function to calculate water indices and detect water using thresholds,
// taken from https://www.mdpi.com/1424-8220/20/2/431/
// only use indices/thresholds from table 5 with OA over 90%
// Result is a multi band image of water from multiple water detection methods
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
  var TCW = im.expression(
      '0.1511 * b + 0.1973 * g + 0.3283 * r + 0.3407 * n + -0.7117 * s1 + -0.4559 * s2',
      {
          'b': im.select('blue').toFloat(),
          'g': im.select('green').toFloat(),
          'r': im.select('red').toFloat(),
          'n': im.select('NIR').toFloat(),
          's1': im.select('SWIR1').toFloat(),
          's2': im.select('SWIR2').toFloat(),
      }).rename('TCW').toFloat();
  
  // Normalized Difference Vegetation Index
  var NDVI = im.normalizedDifference(["NIR","red"]).rename('NDVI').toFloat();

  // Add bands to image
  var im_Bands = im.addBands([MNDWI,AWEIsh,TCW,NDVI]);
    
  // Return image with only the selected bands
  return im_Bands.select(['red','green','blue','MNDWI','AWEIsh','TCW','NDVI']);
}
// Apply function to optical image collection
var collection_ind = L8.map(waterMapping);

/** ----------Mosaic image collection to increase spatial coverage---------- **/
var collection_ind_mosaic = collection_ind.mosaic();

/** ----------Random Forest Classification---------- **/
// Define bands to use for training
var bands = ['MNDWI','AWEIsh','TCW','NDVI'];

//Make training data by 'overlaying' the points on the first image
var observedPoints = collection_ind_mosaic.select(bands).sampleRegions({
  collection: points, 
  properties: ['water'],
  projection: collection_ind_mosaic.projection(),
  scale: 30
}).randomColumn();

// Randomly split the samples to set some aside for testing the model's accuracy
// using the "random" column. Roughly 80% for training, 20% for testing.
var split = 0.8;
var training = observedPoints.filter(ee.Filter.lt('random', split));
var testing = observedPoints.filter(ee.Filter.gte('random', split));

// Develop the RF model using 500 trees 
var classifier = ee.Classifier.smileRandomForest(500).train({ 
  features: training,
  classProperty: 'water',
  inputProperties: bands
});

// Apply the trained classifier to the image mosaic
var classified = collection_ind_mosaic.select(bands).classify(classifier);

/** ----------Filter pixels using the Height Above Nearest Drainage (HAND)----------**/
// Load MERIT Hydro Dataset HAND ('hnd') band
var HAND = ee.Image("MERIT/Hydro/v1_0_1").select('hnd');
// Mask pixels with HAND > 10 m
var HANDmask = HAND.lt(10);
var water_masked = classified.updateMask(HANDmask);
Map.addLayer(water_masked.clip(geometry),{min:0,max:1},'water, HAND-masked');

/** ----------Accuracy Assessment---------- **/
//Print Confusion Matrix, Overall Accuracy, and Kappa for Validation Points
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
Map.addLayer(AZOutline,{color:'black'},'Arizona State Outline');
Map.addLayer(studyArea,{color:'green',opacity: 0.8},'Study Area',false);
Map.addLayer(water,{color:'blue'},'Water Validation Points');
Map.addLayer(nonWater,{color:'brown'},'Non-Water Validation Points');
Map.centerObject(geometry,12);

/** ----------Optional: export pre-processed and classified images in "geometry" polygon---------- **/
var L8S2_classified = water_masked.clip(geometry);
var L8S2_preprocessed = collection_ind_mosaic.clip(geometry);
Export.image.toDrive({
  image: L8S2_classified,
  description: "L8S2_classified",
  folder: 'NASA_DEVELOP',
  scale: 30,
  maxPixels: 1e13
});
Export.image.toDrive({
  image: L8S2_preprocessed,
  description: "L8S2_preprocessed",
  folder: 'NASA_DEVELOP',
  scale: 30,
  maxPixels: 1e13
});