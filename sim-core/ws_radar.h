#pragma once

#include <array>
#include <cstdint>

class Terrain;

class Radar {
private:
    // Targets are refreshed by the caller; tracks persist across beam revisits.
    struct Target {
        std::uint32_t id = 0;
        float posX = 0.0f;
        float altitude = 0.0f;
        float posZ = 0.0f;
    };

    // Stores the latest beam return and its age for one tracked aircraft.
    struct Track {
        bool active = false;
        std::uint32_t targetId = 0;
        float rangeNm = 0.0f;
        float azimuth = 0.0f;
        float elevation = 0.0f;
        double lastDetectionTime = 0.0;
    };

    static constexpr int maxTargets = 64;
    static constexpr int maxTracks = 64;
    std::array<Target, maxTargets> targets{};
    std::array<Track, maxTracks> tracks{};
    int targetCount = 0;
    // Radar time drives the repeating scan independently of browser frame time.
    double radarTime = 0.0;

    // Resolves a compact, active-contact index to its stored track.
    const Track* getTrack(int index) const;

public:
    // Clears targets, tracks, and scan phase when the radar is powered off.
    void reset();
    // Replaces the target set on the next update without clearing existing tracks.
    void clearTargets();
    // Adds a finite world-space target; returns false when invalid or at capacity.
    bool addTarget(std::uint32_t id, float posX, float altitude, float posZ);
    // Advances the scan and updates returns using the aircraft's current pose.
    void tick(float dt, float posX, float altitude, float posZ, const Terrain& terrain,
        float heading, float pitch, float roll);

    // Exposes active tracks in compact index order; invalid indices return safe defaults.
    int getContactCount() const;
    std::uint32_t getContactTargetId(int index) const;
    float getContactRangeNm(int index) const;
    float getContactAzimuth(int index) const;
    float getContactElevation(int index) const;
    float getContactAge(int index) const;
    // Reports the beam position and elevation-bar number currently being scanned.
    float getScanAzimuth() const;
    int getScanBar() const;
};
