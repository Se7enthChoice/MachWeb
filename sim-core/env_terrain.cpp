#include "env_terrain.h"

#include <algorithm>
#include <cmath>

#include "utils.h"

// Validates and copies the heightmap and its feet-based grid metadata.
// dataPointer must address width * height finite float samples in meters.
bool Terrain::setData(
    unsigned int dataPointer,
    int width,
    int height,
    float spacingXFeet,
    float spacingZFeet,
    float originXFeet,
    float originZFeet) {
    if (dataPointer == 0 || width < 2 || height < 2 || width > 4096 || height > 4096 ||
        !std::isfinite(spacingXFeet) || spacingXFeet <= 0.0f ||
        !std::isfinite(spacingZFeet) || spacingZFeet <= 0.0f ||
        !std::isfinite(originXFeet) || !std::isfinite(originZFeet)) {
        return false;
    }

    const std::size_t sampleCount = static_cast<std::size_t>(width) *
        static_cast<std::size_t>(height);
    const float* samples = reinterpret_cast<const float*>(
        static_cast<std::uintptr_t>(dataPointer));
    if (!std::all_of(samples, samples + sampleCount,
            [](float value) { return std::isfinite(value); })) {
        return false;
    }

    heightsMeters.assign(samples, samples + sampleCount);
    this->width = width;
    this->height = height;
    this->spacingXFeet = spacingXFeet;
    this->spacingZFeet = spacingZFeet;
    this->originXFeet = originXFeet;
    this->originZFeet = originZFeet;
    return true;
}

// Discards the cached heightmap and resets its dimensions.
void Terrain::clear() {
    heightsMeters.clear();
    width = 0;
    height = 0;
}

// Returns the bilinearly interpolated height in meters, or zero outside the map.
float Terrain::sampleHeightMeters(float xFeet, float zFeet) const {
    if (heightsMeters.empty()) return 0.0f;

    const float gridX = (xFeet - originXFeet) / spacingXFeet;
    const float gridZ = (zFeet - originZFeet) / spacingZFeet;
    if (!std::isfinite(gridX) || !std::isfinite(gridZ) ||
        gridX < 0.0f || gridZ < 0.0f ||
        gridX > width - 1 || gridZ > height - 1) {
        return 0.0f;
    }

    const int x0 = static_cast<int>(gridX);
    const int z0 = static_cast<int>(gridZ);
    const int x1 = std::min(x0 + 1, width - 1);
    const int z1 = std::min(z0 + 1, height - 1);
    const float fractionX = gridX - x0;
    const float fractionZ = gridZ - z0;
    const float northWest = heightsMeters[z0 * width + x0];
    const float northEast = heightsMeters[z0 * width + x1];
    const float southWest = heightsMeters[z1 * width + x0];
    const float southEast = heightsMeters[z1 * width + x1];
    const float north = northWest + (northEast - northWest) * fractionX;
    const float south = southWest + (southEast - southWest) * fractionX;
    return north + (south - north) * fractionZ;
}

// Samples terrain at a feet-based world position and converts the result to feet.
float Terrain::getElevationFeet(float xFeet, float zFeet) const {
    return sampleHeightMeters(xFeet, zFeet) * M_to_F;
}
