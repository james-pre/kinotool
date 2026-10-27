#include "session.hxx"

Object Init(Env env, Object exports) {
	exports.Set("Session", Session::Define(env));
	return exports;
}

NODE_API_MODULE(native, Init)
