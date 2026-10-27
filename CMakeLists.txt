cmake_minimum_required(VERSION 3.15)
project(native)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_compile_definitions(NAPI_VERSION=10)

add_definitions(
	-DNODE_ADDON_API_CPP_EXCEPTIONS
	-DNODE_ADDON_API_CPP_EXCEPTIONS_ALL
)

find_package(PkgConfig REQUIRED)

# The flags from pkg-config select libtorrent's ABI, so they have to be used rather than just the headers
pkg_check_modules(LIBTORRENT IMPORTED_TARGET libtorrent-rasterbar)

if(NOT LIBTORRENT_FOUND)
	message(FATAL_ERROR "Could not find libtorrent-rasterbar. Install its development headers (e.g. rb_libtorrent-devel).")
endif()

execute_process(
	COMMAND node -p "require('node-addon-api').include_dir"
	WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
	OUTPUT_VARIABLE NODE_ADDON_API_DIR
	OUTPUT_STRIP_TRAILING_WHITESPACE
)

file(GLOB SRC "src/torrent/*.cxx")

add_library(${PROJECT_NAME} SHARED ${SRC} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES
	PREFIX ""
	SUFFIX ".node"
	LIBRARY_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist/torrent"
	RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist/torrent"
)
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB} PkgConfig::LIBTORRENT)
target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_23)
