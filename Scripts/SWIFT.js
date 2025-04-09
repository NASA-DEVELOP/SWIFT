/*
Include the following imports (7 entries):

var nonwater : codeAssets/ObservedPoints/nonWaterPoints.shp
var water : codeAssets/ObservedPoints/waterPoints.shp
var states : codeAssets/Regions_USGS/GU_StateOrTerritory.shp
var studyArea : codeAssests/SouthwestWater_studyArea.shp
var Allotment_SWregion : codeAssets/AllotmentSWregion.shp
var forests : codeAssets/ProclaimedForest.shp
var waterArea_alltoments : codeAssets/waterAreaAllotments_compiled.csv
*/

// ---------------------------------------------------------------
// File: SWIFT
// Name: SWIFT (Surface Water Identification and Forecasting Tool)
// Date: August 8, 2021
// Contact: Kyle Paulekas, kjpaulekas@gmail.com
// -----------------
// Description: Tool to measure the near-current total surface water extent in the user-defined grazing allotment
//              which is plotted with respect to historical water extent data. 
//
// Usage: This code is scripted to run in Google Earth Engine to 
//        classify water and non-water image pixels in the study region 
//        (ROI). Water is classified using a Random Forest Classification scheme using 303 observed points
//        to train the model. This will enable users to receive near-real time water extent observations
//        in various grazing allotments to inform land and livestock management decisions.
//        
// Parameters:
//    In: Allotment (selected by user to filter imagery bounds),
//        Water and Non-Water point observations for 2018-01-28 (training and testing data),
//        Modified Normalized Difference Water Index (MNDWI), Automated Water Extraction Index 
//        corrected for shadows (AWEIsh), Tassled-Cap Wetness (TWC), and Normalized Difference 
//        Vegetative Index (NDVI).
//   
//    Out: Total area of water within the allotment for the most recent satellite imagery, 
//          historical water extents for the respective allotment.
// ---------------------------------------------------------------
// 
// Import records:
// var non-water: FeatureCollection "Non-Water point observations, 2018-01-28"
// var water: FeatureCollection "Water point observations, 2018-01-28"
// var L8: ImageCollection "USGS Landsat 8 Surface Reflectance Tier 1"
// var S2: ImageCollection "ESA Sentinel-2 Surface Reflectance Level 1-C"
// var S1: ImageCollection "ESA Sentinel-1 C-band Synthetic Aperture Radar Ground Range Detected, log scaling"
// var states: FeatureCollection "Federal State or Territory Borders"
// var Allotment_SWregion: Table "USFS Grazing Allotments in the Southwest US"
// var forests: Table "Proclaimed Forests in the US"
// ===================================================================================================================

/** ----------Extract info from assets ----------**/
var SWregion = ee.FeatureCollection(states);
var stateNames = SWregion.aggregate_array('State_Name').sort().distinct();
var allotments = ee.FeatureCollection(Allotment_SWregion);
var allotment_NF = allotments.aggregate_array('National_F').sort();
var unique_forests = allotment_NF.distinct();
// Create an empty image into which to paint the features, cast to byte.
var empty = ee.Image().byte();
// Paint state edges with the same number and width, display.
var stateOutlines = empty.paint({
  featureCollection: states,
  color: 'white',
  width: 2
});
var allotmentOutlines = empty.paint({
  featureCollection: allotments,
  color: 'white',
  width: 1
});

/** ----------Set up main panel---------- **/
//App title
var header =  ui.Label('Surface Water Identification and Forecasting Tool (SWIFT)', {
    fontSize: '20px', fontWeight: 'bold'});

//App summary
var text = ui.Label(
   'SWIFT detects surface water bodies in arid environments using water detection indices and a Random Forest Classification algorithm. ' +
   'Use the tools below to assess water area per grazing allotment.',
   {fontSize: '15px'});

// Generate main panel and add it to the root
var mainPanel = ui.Panel({
  widgets: [header, text], //Adds header and summary text to panel
  style: {width:'300px', position: 'middle-right'}});
ui.root.insert(1,mainPanel);

// Create separator bars for sections in main panel
var separator1 = ui.Label({
  value: '______________________________________',
  style: {fontWeight: 'bold', color: '26c1c9'}
});

var separator2 = ui.Label({
  value: '______________________________________',
  style: {fontWeight: 'bold', color: '26c1c9'}
});

// Define dates
var years = ee.Array(ee.List.sequence(2013,2022,1));
var months = ee.Array(ee.List.sequence(1,12,1));
var days = ee.Array(ee.List.sequence(1,31,1));

// Date selection description
var dateInfo = ui.Label({
  value: '(1) Select End Date',
  style: {fontWeight: 'bold', fontSize: '16px'}
});
var dateInfo2 = ui.Label({
  value: "Images will be collected for the previous week. (Default: today's date)",
  style: {fontSize: '14px'}
});

// Date selector
var dateSelect = ui.DateSlider(ee.Date('2013-03-01'),ee.Date(Date.now()));

// Area of Interest (AOI) selection description
var AOISelect = ui.Label({
  value: '(2) Select Area of Interest',
  style: {fontWeight: 'bold', fontSize: '16px'}
});

// Drop-down selections for the Area of Interest (AOI)
var stateDD = ui.Select([], 'Loading...');
var nationalforestDD = ui.Select([], 'Waiting for a State...');
var districtDD = ui.Select([], 'Waiting for a Forest...');
var allotmentDD = ui.Select([], 'Waiting for a District...');

/** ----------Set up results panel---------- **/
// Generate main panel and add it to the map
var resultsPanel = ui.Panel({
  style: {width:'300px', position: 'top-left'}});
  
// Create label for image capture date
var dateLabel = ui.Label({
  value: 'Classifying Images...',
  style: {whiteSpace: 'pre', fontSize: '14px'}
});
// Create label for water area in allotment
var areaLabel = ui.Label({
  value: ' ',
  style: {whiteSpace: 'pre', fontSize: '14px'}
});
  
/** ----------Define required functions---------- **/
//Function to get National Forests once state is selected
function getForest(state){
  var forestNames = allotments.filterMetadata('State_Name', 'equals', state);
  return forestNames.aggregate_array('National_F').sort().distinct();
}

//Function to get ranger district once National Forest is selected
function getDistrict(forest){
  var districtNames = allotments.filterMetadata('National_F', 'equals', forest);
  return districtNames.aggregate_array('ADMIN_ORG_').sort().distinct();
}

//Function to get allotment once district is selected
function getAllotment(district){
  var allotmentNames = allotments.filterMetadata('ADMIN_ORG_', 'equals', district);
  return allotmentNames.aggregate_array('ALLOTMENT_').sort().distinct();
}

// Function to plot chart of water areal extent  
function timeSeriesPlot(allotmentSelected){
  // Load time series of water extents for selected allotment
  var allotment = waterArea_allotments.filter(ee.Filter.eq('allotmentName',allotmentSelected));
  var allotmentName = allotment.aggregate_array('allotmentName');
  allotmentName = ee.String(allotmentName.get(0));
  var dates = allotment.aggregate_array('date');
  var areas = allotment.aggregate_array('area');
  var areas_sorted = areas.sort(dates);
  var dates_sorted = dates.sort();
  // Create chart and add to panel
  var chart = ui.Chart.array.values({
    array: areas_sorted,
    axis: 0,
    xLabels: dates_sorted
  })
  .setChartType('LineChart')
  .setOptions({
    title: ee.String('Surface Water Extent in ').cat(allotmentName),
    colors: ['#253494'],
    hAxis: {
      title: 'Date',
      titleTextStyle: {italic: false, bold: true}
    },
    vAxis: {
      title: 'Surface Water Area (m^2)',
      titleTextStyle: {italic: false, bold: true}
    },
    lineSize: 1,
    pointSize: 3,
    dataOpacity: 0.8,
    legend: {position: 'none'}
  });  
  return chart;
}

/** ----------Create Legend for Classified Images and Buttons---------- **/
// set position of panel
var legend = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px 15px'
  }
});
    
// Creates and styles 1 row of the legend.
var makeRow = function(color, name) {
  // Create the label that is actually the colored box.
  var colorBox = ui.Label({
    style: {
      backgroundColor: '#' + color,
      // Use padding to give the box height and width.
      padding: '8px',
      margin: '0 0 4px 0'
    }
  });
  // Create the label filled with the description text.
  var description = ui.Label({
    value: name,
    style: {margin: '0 0 4px 6px'}
  });
  // return the panel
  return ui.Panel({
    widgets: [colorBox, description],
    layout: ui.Panel.Layout.Flow('horizontal')
  });
};
//  Palette for legend colors
var palette =['084594','f5f5f5'];
// Legend labels
var labels = ['Water','No Water'];
// Add color and labels
for (var i = 0; i < 2; i++) {
  legend.add(makeRow(palette[i], labels[i]));
  }  

// Create Temporal Resolution and Disclaimer 
var End_Disclaimer = ui.Panel([
  ui.Label({
    value: '______________________________________',
    style: {fontWeight: 'bold', color: '26c1c9'}
  }),
  ui.Label({
    value: 'User Disclaimer: Some current functionalities of SWIFT only apply to regions within Arizona, such as the historical time series chart.'
  }),
  ui.Label({
    value: 'Landsat 8 Temporal Resolution: 16 Days\nSentienl 2 Temporal Resolution: 10 Days\nSentinel 1 Temporal Resolution: 12 Days',
    style: {whiteSpace: 'pre', fontSize: '10px'}
  }),
  ui.Label({
    value: 'SWIFT does not replace the need for field-collected data. The tool aids the user by reducing the revisit time for field-collected data with earth observations.',
    style: {fontSize: '10px'}
  })
  ]);
  
// Button to classify allotment
var classifyButton = ui.Button('Classify Allotment');

// Button to reset the map, and add the states layer 
var reset = ui.Button('Reset Map');
reset.onClick(function(reset){
  Map.layers().remove(Map.layers());
  Map.addLayer(stateOutlines,{},'State Outlines');
});

/** ----------Add widgets to the main panel in the order you want them to appear---------- **/
mainPanel.add(separator1)
  .add(dateInfo)
  .add(dateInfo2)
  .add(dateSelect)
  .add(separator2)
  .add(AOISelect)
  .add(stateDD)
  .add(nationalforestDD)
  .add(districtDD)
  .add(allotmentDD)
  .add(classifyButton)
  .add(End_Disclaimer);
     
/** ----------Run through selections and classification----------**/
// Select state => forest => district => grazing allotment 
stateNames.evaluate(function(s){
  // Add states map and center
  Map.addLayer(stateOutlines,{},'State Outlines');
  Map.centerObject(states,5);
  // Reset drop-down with state names
  stateDD.items().reset(s);
  stateDD.setPlaceholder('Select a State');
  // Setup process after state is selected
  stateDD.onChange(function(state){
    Map.centerObject(states.filterMetadata('State_Name','equals',state));
    stateDD.setPlaceholder('Loading...');
    // Get all national forests state
    var forestNames = getForest(state);
    forestNames.evaluate(function(f){
      // Reset drop-down with forest names
      nationalforestDD.items().reset(f);
      nationalforestDD.setPlaceholder('Select a National Forest');
      // Set up process after forest is selected
      nationalforestDD.onChange(function(forest){
        districtDD.setPlaceholder('Loading...');
        // Get all districts in forest
        var districtNames = getDistrict(forest);
        districtNames.evaluate(function(d){
          // Reset drop-down with forest names
          districtDD.items().reset(d);
          districtDD.setPlaceholder('Select a Ranger District');
          // Set up process after district is selected
          districtDD.onChange(function(selection){
            var districtSelected = allotments.filterMetadata('ADMIN_ORG_','equals',selection);
            // Add selected district to map
            Map.addLayer(districtSelected,{color:'#9e9ac8'},'District');
            Map.centerObject(districtSelected);
            allotmentDD.setPlaceholder('Loading...');
            // Get all allotments in district
            var allotmentNames = getAllotment(selection);
            allotmentNames.evaluate(function(a){
              // Reset drop-down with allotment names
              allotmentDD.items().reset(a);
              allotmentDD.setPlaceholder('Select an allotment');
              // Set up process after allotment is selected
              allotmentDD.onChange(function(selection){
                // Get selected allotment information
                var allotmentSelected = allotments.filterMetadata('ALLOTMENT_','equals',selection);
                Map.addLayer(allotmentSelected,{color:'#54278f'},'Allotment');
                Map.centerObject(allotmentSelected);
                // Classify imagery when button is clicked
                classifyButton.onClick(function(classifyButton){
                  // Classify recent imagery over selected allotment
                  var classify = require('users/DEVELOP_Geoinformatics/default:SWIFT_Files/SWIFT_classify');
                  // Specify Area of Interest (AOI) required for classification
                  var AOI = allotmentSelected;
                  // Get end date from dateSelect
                  var dateSelected = dateSelect.getValue();
                  dateSelected = dateSelected[0];
                  // Run classification
                  var results = classify.classifyWater(AOI,ee.Date(dateSelected).advance(-5,'day'),ee.Date(dateSelected));
                  // Add legend to map 
                  Map.add(legend); 
                  // Add true color image to map (clipped to the AOI)
                  Map.addLayer(results.select(['red','green','blue']).clip(AOI),{min:0, max:2200},'True Color Image');
                 // Add classified image to the map
                  Map.addLayer(results.select('classification'),{palette:['#f5f5f5', '#084594'],min:0,max:1},'Classified Image');
                  // Add results panel to map
                  Map.add(resultsPanel);
                  // Add image capture date and area results labels to panel
                  resultsPanel.add(dateLabel).add(areaLabel);
                  // Add image date and water area results to panel after classification is complete
                  results.get('dateYMD').evaluate(function(val){
                    dateLabel.setValue('Image Capture Date:\n'+val);
                  });
                  results.get('area(m2)').evaluate(function(val){
                    areaLabel.setValue('\nArea of Water in Allotment (square meters):\n'+val);
                  });
                  // Get chart of time series
                  var chart = timeSeriesPlot(selection);
                  resultsPanel.add(chart);
                });
              });
            });
          });
        });
      });
    });
  });
});