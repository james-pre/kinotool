#include <cstring>
#include <libtorrent/settings_pack.hpp>
#include "convert.hxx"

std::string toHex(const lt::sha1_hash &hash) {
	static const char digits[] = "0123456789abcdef";

	std::string hex;
	hex.reserve(hash.size() * 2);

	for (std::uint8_t byte : hash) {
		hex.push_back(digits[byte >> 4]);
		hex.push_back(digits[byte & 0xf]);
	}

	return hex;
}

static const char *stateName(lt::torrent_status::state_t state) {
	switch (state) {
		case lt::torrent_status::checking_files: return "checking_files";
		case lt::torrent_status::downloading_metadata: return "downloading_metadata";
		case lt::torrent_status::downloading: return "downloading";
		case lt::torrent_status::finished: return "finished";
		case lt::torrent_status::seeding: return "seeding";
		case lt::torrent_status::checking_resume_data: return "checking_resume_data";
		default: return "unknown";
	}
}

Object fromStatus(const Env &env, const std::string &id, const lt::torrent_status &status) {
	Object object = Object::New(env);

	object.Set("id", id);
	object.Set("name", status.name);
	object.Set("state", stateName(status.state));
	object.Set("directory", status.save_path);
	object.Set("progress", status.progress);
	object.Set("downloadRate", status.download_payload_rate);
	object.Set("uploadRate", status.upload_payload_rate);
	object.Set("wanted", static_cast<double>(status.total_wanted));
	object.Set("done", static_cast<double>(status.total_wanted_done));
	object.Set("uploaded", static_cast<double>(status.all_time_upload));
	object.Set("peers", status.num_peers);
	object.Set("seeds", status.num_seeds);
	object.Set("paused", static_cast<bool>(status.flags & lt::torrent_flags::paused));
	object.Set("error", status.errc ? static_cast<Value>(String::New(env, status.errc.message())) : env.Null());

	return object;
}

Uint8Array fromBuffer(const Env &env, const std::vector<char> &buffer) {
	Uint8Array array = Uint8Array::New(env, buffer.size());
	std::memcpy(array.Data(), buffer.data(), buffer.size());
	return array;
}

lt::settings_pack toSettings(const Object &object) {
	Env env = object.Env();
	lt::settings_pack pack;

	Array names = object.GetPropertyNames();

	for (std::uint32_t i = 0; i < names.Length(); i++) {
		std::string name = names.Get(i).As<String>();
		Value value = object.Get(name);

		int setting = lt::setting_by_name(name);
		if (setting < 0)
			throw TypeError::New(env, "Unknown setting: " + name);

		switch (setting & lt::settings_pack::type_mask) {
			case lt::settings_pack::string_type_base:
				if (!value.IsString())
					throw TypeError::New(env, "Setting " + name + " must be a string");
				pack.set_str(setting, value.As<String>());
				break;
			case lt::settings_pack::int_type_base:
				if (!value.IsNumber())
					throw TypeError::New(env, "Setting " + name + " must be a number");
				pack.set_int(setting, value.As<Number>().Int32Value());
				break;
			case lt::settings_pack::bool_type_base:
				if (!value.IsBoolean())
					throw TypeError::New(env, "Setting " + name + " must be a boolean");
				pack.set_bool(setting, value.As<Boolean>());
				break;
		}
	}

	// Alerts are how torrents report back, so the categories they are converted from can't be turned off
	pack.set_int(
		lt::settings_pack::alert_mask,
		static_cast<int>(static_cast<std::uint32_t>(
			lt::alert_category::error | lt::alert_category::status | lt::alert_category::storage
		))
	);

	return pack;
}
