/*
Include the following imports (2 entries):

var waterPoints :codeAssets/ObservedPoints/waterPoints.shp
var nonWaterPoints :codeAssets/ObservedPoints/nonWaterPoints.shp
*/

// ---------------------------------------------------------------
// File: SWIFT_classify
// Name: SWIFT (Surface Water Identification and Forecasting Tool)
// Date: August 13, 2021
// Contact: Kyle Paulekas, kjpaulekas@gmail.com
// ---------------------------------------------------------------
// Description: Function to classify water using the region of interest specified by users.
//
// Usage: This code is scripted to run in Google Earth Engine to
//        classify water and non-water image pixels in recent imagery for the selected 
//        grazing allotment in Arizona. Water is classified using
//        a Random Forest Classification scheme using 303 observed points
//        to train the model. This will allow users access near real-time observations
//        of of surface water extents within a selected grazing allotment.
//
// Parameters:
//    In: Water and Non-Water point observations for 2018-01-28 (training and testing data),
//        Modified Normalized Difference Water Index (MNDWI), Automated Water Extraction Index
//        corrected for shadows (AWEIsh), Tassled-Cap Wetness (TCW), and Normalized Difference
//        Vegetative Index (NDVI) (optical imagery classification), 'VV', 'VH', and 'angle'
//        bands (radar imagery classification).
//
//    Out: Total area of water within the area of interest (AOI) and in each grazing allotment
//         in Arizona.
// ---------------------------------------------------------------
//
// Import records:
// var L8: ImageCollection "USGS Landsat 8 Surface Reflectance Tier 1"
// var S2: ImageCollection "ESA Sentinel-2 Surface Reflectance Level 1-C"
// var S1: ImageCollection "ESA Sentinel-1 C-band Synthetic Aperture Radar Ground Range Detected, log scaling"
// ===================================================================================================================

var L8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2");
var S2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED");
var S1 = ee.ImageCollection("COPERNICUS/S1_GRD");

exports.classifyWater = function (AOI,start_date,end_date){
  
  /** ---------Optical image pre-processing functions---------- **/
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
  // Sentinel-2 band pass adjustment coefficients
  // Coefficients from https://www.sciencedirect.com/science/article/pii/S0034425718304139
  var GAIN = ee.Image.constant([0.9778, 1.0053, 0.9765, 0.9983, 0.9987, 1.003]);
  var BIAS = ee.Image.constant([-0.00411, -0.00093, 0.00094, -0.0001, -0.0015, -0.0012]);
  function harmonize(S2im){
      var landsatLike = S2im.multiply(GAIN).add(BIAS);
      return landsatLike.copyProperties(S2im,["system:time_start"]);
  }  

  /** ----------Add water indices to image---------- **/
  // Function to calculate water indices and detect water using thresholds
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
    return im_Bands.select(['MNDWI','AWEIsh','TCW','NDVI']);
  }

  /** ----------Develop training and testing data using digitized points---------- **/
  var waterPts = ee.FeatureCollection(waterPoints.map(function(p){
    return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':1});
  })); 
  var nonWaterPts = ee.FeatureCollection(nonWaterPoints.map(function(p){
    return ee.Feature(ee.Geometry.Point(p.geometry().coordinates()), {'water':0});
  })); 
  
  // merge water and non-water points into training data
  var points = waterPts.merge(nonWaterPts);

  // Define L8 training collection
  var L8training = (ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(waterPoints)
    .filterDate('2018-01-27', '2018-02-02')
    .filter(ee.Filter.lt('CLOUD_COVER', 10))
    .map(L8QAMask)
    .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
    ['blue','green','red','NIR','SWIR1','SWIR2'])
  );

  // Define S2 training collection
  var S2training = (ee.ImageCollection('COPERNICUS/S2')
    .filterBounds(waterPoints)
    .filterDate('2018-01-27', '2018-02-02')
    .filter(ee.Filter.lt('CLOUD_COVERAGE_ASSESSMENT', 10))
    .map(S2QAMask)
    .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
    ['blue','green','red','NIR','SWIR1','SWIR2'])
    .map(harmonize)
  );
  // Merge training collections
  var L8S2training = L8training.merge(S2training);

  var L8S2training_ind = L8S2training.map(waterMapping);
  // Mosaic images to increase spatial coverage
  var L8S2training_ind_mosaic = L8S2training_ind.mosaic();
  // Define bands to use for training
  var optical_bands = ['MNDWI','AWEIsh','TCW','NDVI'];

  // Make optical training data by 'overlaying' the points on the first image
  var optical_training = L8S2training_ind_mosaic.select(optical_bands).sampleRegions({
    collection: points, 
    properties: ['water'],
    projection: L8S2training_ind_mosaic.projection(),
    scale: 30
  }).randomColumn();
  
  // Develop the optical RF model for optical imagery using 500 trees
  var optical_classifier = ee.Classifier.smileRandomForest(500).train({ 
    features: optical_training,
    classProperty: 'water',
    inputProperties: optical_bands
  });
  
  // Preprocess the S1 training collection
  // Import scripts from Mullissa et al. (2021)
  var wrapper = require('users/adugnagirma/gee_s1_ard:wrapper');
  var helper = require('users/adugnagirma/gee_s1_ard:utilities');
  
  // Define S-1 parameters
  var parameter_training = {//1. Data Selection
                START_DATE: '2018-01-27',
                STOP_DATE: '2018-02-07',
                POLARIZATION:'VVVH',
                ORBIT : 'BOTH',
                //GEOMETRY: geometry, //uncomment if interactively selecting a region of interest
                GEOMETRY: waterPoints,
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
  var S1_preprocess_training = wrapper.s1_preproc(parameter_training);
  var S1 = S1_preprocess_training[0];
  S1_preprocess_training = S1_preprocess_training[1];
  // Mosaic image collection to increase spatial coverage
  var S1_mosaic = S1_preprocess_training.mosaic();
  //Make S1 training data by 'overlaying' the points on the first image
  var S1_training = S1_mosaic.sampleRegions({
    collection: points, 
    properties: ['water'], 
    scale: 10
  }).randomColumn();

  // Define S1 bands to use in classification
  var S1_bands = ['VV','VH','angle'];
  
  // Develop the radar RF model using 500 trees 
  var S1_classifier = ee.Classifier.smileRandomForest(500).train({ 
    features: S1_training,
    classProperty: 'water',
    inputProperties: S1_bands
  });

  /** ----------Define image collections and classify---------- **/
  var L8 = (ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(AOI)
    .filterDate(start_date, end_date)
    .filter(ee.Filter.calendarRange(3,11,'month'))
    .filter(ee.Filter.lt('CLOUD_COVER', 50))
    .map(L8QAMask)
    .select(['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
   ['blue','green','red','NIR','SWIR1','SWIR2'])
   );
  var S2 = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(AOI)
    .filterDate(start_date, end_date)
    .filter(ee.Filter.calendarRange(3,11,'month'))
    .filter(ee.Filter.lt('CLOUD_COVERAGE_ASSESSMENT', 50))
    .map(S2QAMask)
    .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
    ['blue','green','red','NIR','SWIR1','SWIR2'])
    .map(harmonize)
  );
  var L8S2 = L8.merge(S2);
  print(L8S2.first().bandNames());
  print("hi");
  var L8S2_ind = L8S2.map(waterMapping);
  var L8S2_classified = L8S2_ind.map(function(im){return im.classify(optical_classifier)});

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

  // Preprocess the image collection
  var S1_preprocess = wrapper.s1_preproc(parameter);
  var S1 = S1_preprocess[0];
  S1_preprocess = S1_preprocess[1];
  
  // Classify S-1 collection
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
  // Smooth the image S-1 image collection and apply a wind mask for wind speeds > 12 km/h
  var S1_classified = S1_cf.map(function(im){return im.select('classification')
    .convolve(boxcar).gt(0.97)})
    .map(windMask);

  /** ----------Mosaic classified images by week---------- **/
  // Merge collections and clip to AOI
  var collection = L8S2_classified.merge(S1_classified).map(function(im){return im.clip(AOI)});
  
  // Create image mosaics for each week in the collection
  function mosaicByDate(date) {
    var composite = collection.median()
        .set('system:time_start', date.millis(), 'dateYMD', date.format('YYYY-MM-dd'),
        'numbImages', collection.size());
    return composite;
  }
  
  // Iterate over the range to make a new list, and then cast the list to an imagecollection
  var weekDifference = ee.Date(start_date).advance(1, 'week').millis().subtract(ee.Date(start_date).millis());
  var listMap = ee.List.sequence(ee.Date(start_date).millis(), ee.Date(end_date).millis(), weekDifference);
  var weeklyMosaics = ee.ImageCollection.fromImages(listMap.map(function(dateMillis){
    var date = ee.Date(dateMillis);
    return mosaicByDate(date);
  }));

  /** ----------Define water where classification = 1---------- **/
  function maskNonWater(im){
    return im.updateMask(im.select('classification').lt(1));
  }
  var water_collection = weeklyMosaics.map(maskNonWater);

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
      .multiply(ee.Image.pixelArea())
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
      
    return im.set({'area(m2)':area,'date':date});
  
  }
  var waterArea_AOI = water_collection.map(calculateWaterArea_AOI);
  
  // Add true color bands for viewing
  var im_return = waterArea_AOI.first().addBands(L8S2.first().select(['blue','green','red']));
  
  // Export results
  return im_return;

};