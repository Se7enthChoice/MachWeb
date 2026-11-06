#pragma once

#include <vector>

class Terrain {
private:
    std::vector<float> heightsMeters;
    int width = 0;
    int height = 0;
    float spacingXFeet = 0.0f;
    float spacingZFeet = 0.0f;
    float originXFeet = 0.0f;
    float originZFeet = 0.0f;

    float sampleHeightMeters(float xFeet, float zFeet) const;

public:
    bool setData(
        unsigned int dataPointer,
        int width,
        int height,
        float spacingXFeet,
        float spacingZFeet,
        float originXFeet,
        float originZFeet);
    void clear();
    float getElevationFeet(float xFeet, float zFeet) const;
};
