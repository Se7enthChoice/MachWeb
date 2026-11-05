#include <algorithm>
#include <cmath>

/* ---CONSTANTS--- */

static constexpr float KTs_to_FPS = 1.68781f; // Conversion factor from knots to feet per second
static constexpr float gravity = 32.174f; // ft/s²
static constexpr float DEG_to_RAD = 3.14159265f / 180.0f; // Conversion factor from degrees to radians
static constexpr float RAD_to_DEG = 180.0f / 3.14159265f; // Conversion factor from radians to degrees
static constexpr float M_to_F = 3.28084f; // Conversion factor from meters to feet
static constexpr float max_airspeed = 850.0f; // Knots
static constexpr float max_vertical_speed = 19600.0f; // Ft/min
static constexpr float cruise_airspeed = 300.0f;
static constexpr float crashed_duration = 3.0f; // Seconds  

// Clamps the input value to the specified range (minimum, maximum) if it is finite; otherwise, returns the minimum value.
static float clamp_finite(float value, float minimum, float maximum) 
{
    return std::isfinite(value) ? std::clamp(value, minimum, maximum) : minimum;
}

// Wraps the input angle to the range (0, 360) degrees.
static float wrap_heading(float angle) 
{
        angle = std::fmod(angle, 360.0f);
        return angle < 0.0f ? angle + 360.0f : angle;
}

// Wraps the input angle to the range (-180, 180) degrees.
static float wrap_signed_angle(float angle) 
{
    angle = std::fmod(angle + 180.0f, 360.0f);
    if (angle < 0.0f) angle += 360.0f;
    return angle - 180.0f;
}

/* ---VECTOR3--- */

struct Vector3 
{
    float x;
    float y;
    float z;
};

// Computes the cross product of two 3D vectors a and b.
static Vector3 cross(const Vector3& a, const Vector3& b) 
{
    return 
    {
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    };
}

// Computes the dot product of two 3D vectors a and b.
static float dot(const Vector3& a, const Vector3& b) 
{
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

// Normalizes the input 3D vector to have a length of 1. If the length is very small, returns a zero vector.
static Vector3 normalized(const Vector3& value) 
{
    const float length = std::sqrt(dot(value, value));
    if (length < 0.0001f) return {0.0f, 0.0f, 0.0f};
    return {value.x / length, value.y / length, value.z / length};
}

// Rotates the input 3D vector 'value' around the specified 'axis' by the given 'angle' (in radians).
static Vector3 rotate_around_axis(const Vector3& value, const Vector3& axis, float angle)
{
    const float cosine = std::cos(angle);
    const float sine = std::sin(angle);
    const Vector3 axisCrossValue = cross(axis, value);
    const float projection = dot(axis, value) * (1.0f - cosine);
    return 
    {
        value.x * cosine + axisCrossValue.x * sine + axis.x * projection,
        value.y * cosine + axisCrossValue.y * sine + axis.y * projection,
        value.z * cosine + axisCrossValue.z * sine + axis.z * projection,
    };
}