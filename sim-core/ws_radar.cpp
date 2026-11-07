#include "ws_radar.h"

#include <algorithm>
#include <cmath>

#include "utils.h"

namespace {
// Search volume and beam characteristics for this simplified fighter radar.
constexpr float maxAzimuth = 60.0f;
constexpr float maxRangeNm = 40.0f;
constexpr float feetPerNauticalMile = 6076.12f;
constexpr float azimuthBeamWidth = 4.0f;
constexpr float elevationBeamWidth = 8.0f;

// Each bar scans one full azimuth sweep; alternating directions avoids a rewind.
constexpr double barSweepSeconds = 0.6;
constexpr double searchCycleSeconds = 2.4;
// Subdivide simulation steps so a narrow beam cannot skip over a target between frames.
constexpr double scanStepSeconds = 0.005;
constexpr double trackCoastSeconds = 3.6;
// Beam centers are separated by one beam width to cover the elevation search volume.
constexpr std::array<float, 4> elevationBars = {-12.0f, -4.0f, 4.0f, 12.0f};

struct ScanPosition {
    float azimuth;
    float elevation;
    int bar;
};

// Converts radar time to the current bar and line-of-sight beam azimuth.
ScanPosition scanPositionAt(double time) {
    const double cycleTime = std::fmod(time, searchCycleSeconds);
    const int bar = std::min(static_cast<int>(cycleTime / barSweepSeconds), 3);
    const float progress = static_cast<float>(
        (cycleTime - bar * barSweepSeconds) / barSweepSeconds);
    const float azimuth = bar % 2 == 0
        ? -maxAzimuth + progress * maxAzimuth * 2.0f
        : maxAzimuth - progress * maxAzimuth * 2.0f;
    return {azimuth, elevationBars[bar], bar};
}

}

void Radar::clearTargets() {
    targetCount = 0;
}

// Rejects malformed or excess inputs instead of passing them to the scan loop.
bool Radar::addTarget(std::uint32_t id, float posX, float altitude, float posZ) {
    if (id == 0 || targetCount >= maxTargets ||
        !std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ)) {
        return false;
    }

    targets[targetCount++] = {id, posX, altitude, posZ};
    return true;
}

// Advances the beam in small time slices and updates tracks only on beam overlap.
void Radar::tick(
    float dt,
    float posX,
    float altitude,
    float posZ,
    float heading,
    float pitch,
    float roll) {
    if (!std::isfinite(dt) || dt <= 0.0f ||
        !std::isfinite(posX) || !std::isfinite(altitude) || !std::isfinite(posZ) ||
        !std::isfinite(heading) || !std::isfinite(pitch) || !std::isfinite(roll)) {
        return;
    }

    dt = std::min(dt, 0.1f);
    Vector3 forward;
    Vector3 up;
    Vector3 right;
    get_orientation_basis(heading, pitch, roll, forward, up, right);

    const int steps = static_cast<int>(std::ceil(dt / scanStepSeconds));
    const double step = dt / steps;
    for (int stepIndex = 0; stepIndex < steps; ++stepIndex) {
        radarTime += step;
        const ScanPosition beam = scanPositionAt(radarTime);

        // Project each target onto the aircraft's forward/right/up radar axes.
        for (int targetIndex = 0; targetIndex < targetCount; ++targetIndex) {
            const Target& target = targets[targetIndex];
            const Vector3 relative{
                target.posX - posX,
                target.altitude - altitude,
                target.posZ - posZ,
            };
            const float distanceFeet = std::sqrt(dot(relative, relative));
            const float rangeNm = distanceFeet / feetPerNauticalMile;
            if (rangeNm <= 0.0f || rangeNm > maxRangeNm) continue;

            // These angles are body-relative, so aircraft pitch and roll affect coverage.
            const float forwardDistance = dot(relative, forward);
            const float rightDistance = dot(relative, right);
            const float upDistance = dot(relative, up);
            const float azimuth = std::atan2(rightDistance, forwardDistance) * RAD_to_DEG;
            const float elevation = std::atan2(
                upDistance,
                std::sqrt(forwardDistance * forwardDistance + rightDistance * rightDistance))
                * RAD_to_DEG;
            if (std::abs(azimuth) > maxAzimuth ||
                std::abs(elevation) > elevationBars.back() + elevationBeamWidth / 2.0f ||
                std::abs(azimuth - beam.azimuth) > azimuthBeamWidth / 2.0f ||
                std::abs(elevation - beam.elevation) > elevationBeamWidth / 2.0f) {
                continue;
            }

            // Refresh an existing track, otherwise use an empty slot or oldest track.
            Track* track = nullptr;
            for (Track& candidate : tracks) {
                if (candidate.active && candidate.targetId == target.id) {
                    track = &candidate;
                    break;
                }
                if (!track && !candidate.active) track = &candidate;
            }
            if (!track) {
                track = &*std::min_element(
                    tracks.begin(),
                    tracks.end(),
                    [](const Track& leftTrack, const Track& rightTrack) {
                        return leftTrack.lastDetectionTime < rightTrack.lastDetectionTime;
                    });
            }
            *track = {true, target.id, rangeNm, azimuth, elevation, radarTime};
        }
    }

    // Keep a return visible briefly while the antenna is looking elsewhere.
    for (Track& track : tracks) {
        if (track.active && radarTime - track.lastDetectionTime > trackCoastSeconds) {
            track.active = false;
        }
    }
}

// Resolves public contact indices without exposing the internal track array.
const Radar::Track* Radar::getTrack(int index) const {
    if (index < 0) return nullptr;
    for (const Track& track : tracks) {
        if (!track.active) continue;
        if (index-- == 0) return &track;
    }
    return nullptr;
}

int Radar::getContactCount() const {
    return static_cast<int>(std::count_if(
        tracks.begin(), tracks.end(), [](const Track& track) { return track.active; }));
}

std::uint32_t Radar::getContactTargetId(int index) const {
    const Track* track = getTrack(index);
    return track ? track->targetId : 0;
}

float Radar::getContactRangeNm(int index) const {
    const Track* track = getTrack(index);
    return track ? track->rangeNm : 0.0f;
}

float Radar::getContactAzimuth(int index) const {
    const Track* track = getTrack(index);
    return track ? track->azimuth : 0.0f;
}

float Radar::getContactElevation(int index) const {
    const Track* track = getTrack(index);
    return track ? track->elevation : 0.0f;
}

float Radar::getContactAge(int index) const {
    const Track* track = getTrack(index);
    return track
        ? static_cast<float>(std::max(0.0, radarTime - track->lastDetectionTime))
        : 0.0f;
}

// The UI uses these values to animate the beam without driving radar behavior.
float Radar::getScanAzimuth() const {
    return scanPositionAt(radarTime).azimuth;
}

int Radar::getScanBar() const {
    return scanPositionAt(radarTime).bar + 1;
}
