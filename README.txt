==========================================================
 Surface Water Identification and Forecasting Tool (SWIFT)
==========================================================

Date Created: August 8, 2021

SWIFT is a resource for land, livestock, and wildlife managers to aid in
management decisions by detecting and monitoring small water bodies by utilizing
Google Earth Engine JavaScript API. The tool employs Landsat 8, Sentinel-1,
and Sentinel-2 to classify pixels as "water" or "non-water". The classification
is accomplished by utilizing multiple water detection indices in a random
forest classification scheme. After the user specifies the date range and
grazing allotment (AOI), classified image collections are mosaicked by date.
Pixels classified as water are used to calculate the total surface water extent
grazing allotment. True color and classified images, as well as the total
surface water extent and historical time series of surface water for the grazing
allotment are displayed.

 Required Packages
===================
* SWIFT_classify


 Parameters
-------------
1. Select State where allotment of intrest is located
2. Select National Forest to filter Allotments
3. Select Ranger District to filter Allotments
4. Select Allotment of Interest to calculate water body surface area.


===============
SWIFT_classify
===============

Date Created: August 13, 2021

This code is scripted to run in Google Earth Engine to classify "water" and
"non-water" pixels for the most recent Landsat 8, Sentinel-1, and Sentinel-2
imagery within the Area of Interest (AOI) for the user-specified date range.
A Random Forest Classification model for both the optical (Landsat 8 and
Sentinel-2) and radar (Sentinel-1) imagery using 500 decision trees and 1424
observed points as training inputs. For optical imagery, several band indices
commonly used for water detection (MNDWI, AWEIsh, TCW, NDVI) are used as
predictors. For radar imagery, the VV and VH polarizations, and the incidence
angle bands are used as predictors. The output is the total surface water extent
within the AOI.


====================
contructTimeSeries
====================

Date Created: August 8, 2021

This code is scripted to run in Google Earth Engine to classify "water" and
"non-water" pixels for the AOI for all images captured within the specified date
range. The constructTimeSeries code estimates the total average weekly water
extent in the AOI using Landsat 8, Sentinel-1, and Sentinel-2. Pixels are classified
as "water" or "non-water" using Random Forest Classification schemes with
1424 observed points used as training inputs. The output is the total area
of water within the AOI and in each grazing allotment in the AOI.

Parameters
----------
*Users must limit the amount of data being exported or a runtime error will be encountered
1. Line 48: Choose start date
2. Line 49: Choose end date by advancing up to 4 weeks.
	(Time longer than 4 weeks results in time out error)
3. Comment in/out lines 405-411 and 444-450 to adjust export settings
	1. Lines 405-411: function to export water area by the study region
	2. Lines 444-45-: function to export water area by Allotments within the region


=====================================
L8S2_ClassificationAccuracyAssessment
=====================================

Date Created: August 12, 2021

This code is scripted to run in Google Earth Engine to classify "water" and
"non-water" pixels in Landsat 8 and Sentinel-2 optical imagery. 80% of the 1424
observed points are used to train the Random Forest Classification model. The
remaining 20% of observed points are used to conduct an accuracy assessment of
the classification model, which is printed to the Console. The accuracy
assessment output provides the user with the confusion matrix, overall accuracy,
and Kappa statistic for the validation points. The optical imagery
classification methodology being validated is implemented in the
constructTimeSeries and SWIFT scripts.


====================================
S1_classificationAccuracyAssessment
====================================

Date Created: August 12, 2021

This code is scripted to run in Google Earth Engine to classify "water" and
"non-water" pixels in Sentinel-1 C-band Synthetic Aperture Radar (SAR) Ground-
Range Detected (GRD) products. 80% of the 1424 observed points are used to train
the Random Forest Classification model. The remaining 20% of observed points are
used to conduct an accuracy assessment of the classification model, which is
printed to the Console. The accuracy assessment output provides the user with
the confusion matrix, overall accuracy, and Kappa statistic for the validation
points. The optical imagery classification methodology being validated is
implemented in the constructTimeSeries and SWIFT scripts.
