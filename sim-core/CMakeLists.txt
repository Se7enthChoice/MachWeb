cmake_minimum_required(VERSION 3.20)
project(SimCore)

set(CMAKE_CXX_STANDARD 23)

# Define the target executable
add_executable(sim-core main.cpp)

# Emscripten specific link flags
target_link_options(sim-core PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPF32']"
    "--bind"
    "-O3" # Optimization level for performance
)

# Ensure the output file ends in .js
set_target_properties(sim-core PROPERTIES SUFFIX ".js")