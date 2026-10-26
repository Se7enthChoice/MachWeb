#include <emscripten/emscripten.h>
#include <emscripten/bind.h>
#include <algorithm>
#include <cmath>

class SimEngine {
private:
    float altitude = 5000.0f;    // Feet
    float airspeed = 300.0f;    // Knots
    float throttle = 0.8f;     // 0.0 to 1.0
    float pitchAngle = 0.0f;   // Degrees (-90 to +90)
    float verticalSpeed = 0.0f; // Feet per minute

public:
    void tick(float dt) {
        // Simple 3rd-gen jet flight physics approximation
        // Thrust accelerates the plane, drag opposes it, pitch affects climb rate.
        
        float targetAirspeed = throttle * 550.0f; // Max speed ~550 kts at full burner
        airspeed += (targetAirspeed - airspeed) * 2.0f * dt; // Smooth interpolation

        // Vertical speed derived from pitch and airspeed
        verticalSpeed = std::sin(pitchAngle * (3.14159265f / 180.0f)) * airspeed * 10.0f;
        
        // Update altitude based on vertical speed (converting knots/climb to ft/sec)
        altitude += (verticalSpeed / 60.0f) * dt;

        // Ground collision floor check
        if (altitude < 0.0f) {
            altitude = 0.0f;
            verticalSpeed = 0.0f;
        }
    }

    // Pilot Inputs from the Web Frontend
    void setThrottle(float val) { throttle = std::clamp(val, 0.0f, 1.0f); }
    void setPitch(float val) { pitchAngle = std::clamp(val, -85.0f, 85.0f); }

    // Telemetry Getters for UI and 3D Viewport
    float getAltitude() const { return altitude; }
    float getAirspeed() const { return airspeed; }
    float getThrottle() const { return throttle * 100.0f; } // Percentage
    float getPitch() const { return pitchAngle; }
    float getVerticalSpeed() const { return verticalSpeed; }
};

// Bind to JavaScript via Embind
EMSCRIPTEN_BINDINGS(sim_engine) {
    emscripten::class_<SimEngine>("SimEngine")
        .constructor<>()
        .function("tick", &SimEngine::tick)
        .function("setThrottle", &SimEngine::setThrottle)
        .function("setPitch", &SimEngine::setPitch)
        .function("getAltitude", &SimEngine::getAltitude)
        .function("getAirspeed", &SimEngine::getAirspeed)
        .function("getThrottle", &SimEngine::getThrottle)
        .function("getPitch", &SimEngine::getPitch)
        .function("getVerticalSpeed", &SimEngine::getVerticalSpeed);
}