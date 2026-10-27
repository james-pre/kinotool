#include <libtorrent/alert_types.hpp>
#include <libtorrent/load_torrent.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/write_resume_data.hpp>
#include "convert.hxx"
#include "session.hxx"

std::shared_ptr<AlertNotifier> AlertNotifier::create(const Napi::Env &env, const Function &callback) {
	auto notifier = std::make_shared<AlertNotifier>();

	// Node finalizes the function itself when the environment shuts down, after which it must not be released
	notifier->function =
		ThreadSafeFunction::New(env, callback, "kinotool torrent alerts", 0, 1, [weak = std::weak_ptr(notifier)](Env) {
			if (auto notifier = weak.lock())
				notifier->close();
		});

	notifier->function.Unref(env);

	return notifier;
}

void AlertNotifier::notify() {
	std::lock_guard lock(mutex);
	if (closed)
		return;
	function.NonBlockingCall();
}

void AlertNotifier::close() {
	{
		std::lock_guard lock(mutex);
		if (closed)
			return;
		closed = true;
	}

	function.Release();
}

/** IDs prefer the v1 hash, which stays the same when a magnet's metadata reveals a v2 hash */
static std::string idFor(const lt::info_hash_t &hashes) {
	return toHex(hashes.has_v1() ? hashes.v1 : hashes.get_best());
}

static lt::span<const char> toSpan(const Napi::Value &value) {
	Uint8Array array = value.As<Uint8Array>();
	return {reinterpret_cast<const char *>(array.Data()), static_cast<std::ptrdiff_t>(array.ByteLength())};
}

static int toIndex(const Napi::Value &value, int count) {
	if (!value.IsNumber())
		throw TypeError::New(value.Env(), "File index must be a number");

	int index = value.As<Number>().Int32Value();
	if (index < 0 || index >= count)
		throw RangeError::New(value.Env(), "File index " + std::to_string(index) + " is out of range");

	return index;
}

static std::shared_ptr<const lt::torrent_info> requireMetadata(const Napi::Env &env, const lt::torrent_handle &handle) {
	std::shared_ptr<const lt::torrent_info> info = handle.torrent_file();
	if (!info)
		throw Error::New(env, "Torrent metadata is not available yet");
	return info;
}

Function Session::Define(Napi::Env env) {
	return DefineClass(
		env,
		"Session",
		{
			InstanceMethod<&Session::Add>("add"),
			InstanceMethod<&Session::Files>("files"),
			InstanceMethod<&Session::Select>("select"),
			InstanceMethod<&Session::Rename>("rename"),
			InstanceMethod<&Session::Pause>("pause"),
			InstanceMethod<&Session::Resume>("resume"),
			InstanceMethod<&Session::SaveResumeData>("saveResumeData"),
			InstanceMethod<&Session::Remove>("remove"),
			InstanceMethod<&Session::Status>("status"),
			InstanceMethod<&Session::PostUpdates>("postUpdates"),
			InstanceMethod<&Session::Alerts>("alerts"),
			InstanceMethod<&Session::ApplySettings>("applySettings"),
			InstanceMethod<&Session::Close>("close"),
		}
	);
}

Session::Session(const CallbackInfo &args) : ObjectWrap<Session>(args) {
	Napi::Env env = args.Env();

	if (!args[1].IsFunction())
		throw TypeError::New(env, "An alert callback is required");

	Object settings = args[0].IsObject() ? args[0].As<Object>() : Object::New(env);

	notifier = AlertNotifier::create(env, args[1].As<Function>());

	session = std::make_unique<lt::session>(lt::session_params(toSettings(settings)));
	session->set_alert_notify([notifier = notifier] { notifier->notify(); });
}

Session::~Session() {
	close();
}

void Session::close() {
	if (!session)
		return;

	notifier->close();

	// Blocks until trackers have been told the torrents stopped
	session.reset();

	torrents.clear();
}

const lt::torrent_handle &Session::find(const Napi::Value &id) {
	if (!session)
		throw Error::New(id.Env(), "Session is closed");

	if (!id.IsString())
		throw TypeError::New(id.Env(), "Torrent ID must be a string");

	auto it = torrents.find(id.As<String>());
	if (it == torrents.end())
		throw Error::New(id.Env(), "Unknown torrent: " + id.As<String>().Utf8Value());

	return it->second;
}

std::optional<std::string> Session::idOf(const lt::torrent_handle &handle) const {
	// Handles compare by owner, so this still matches after the torrent is gone
	for (const auto &[id, other] : torrents) {
		if (other == handle)
			return id;
	}

	return std::nullopt;
}

Napi::Value Session::fromAlert(const Napi::Env &env, const lt::alert *alert) {
	Object object = Object::New(env);

	if (auto *update = lt::alert_cast<lt::state_update_alert>(alert)) {
		Array statuses = Array::New(env);

		for (const lt::torrent_status &status : update->status) {
			if (std::optional<std::string> id = idOf(status.handle))
				statuses.Set(statuses.Length(), fromStatus(env, *id, status));
		}

		object.Set("type", "status");
		object.Set("statuses", statuses);
		return object;
	}

	// Unreachable trackers are routine, and there is nothing to be done about them
	if (dynamic_cast<const lt::tracker_alert *>(alert))
		return env.Undefined();

	auto *torrentAlert = dynamic_cast<const lt::torrent_alert *>(alert);
	std::optional<std::string> id = torrentAlert ? idOf(torrentAlert->handle) : std::nullopt;

	if (id)
		object.Set("id", *id);

	if (!torrentAlert || !id) {
		if (!(alert->category() & lt::alert_category::error))
			return env.Undefined();

		object.Set("type", "warning");
		object.Set("message", alert->message());
		return object;
	}

	if (lt::alert_cast<lt::metadata_received_alert>(alert))
		object.Set("type", "metadata");
	else if (lt::alert_cast<lt::torrent_finished_alert>(alert))
		object.Set("type", "finished");
	else if (lt::alert_cast<lt::torrent_error_alert>(alert)) {
		object.Set("type", "error");
		object.Set("message", alert->message());
	} else if (auto *saved = lt::alert_cast<lt::save_resume_data_alert>(alert)) {
		object.Set("type", "resume_data");
		object.Set("data", fromBuffer(env, lt::write_resume_data_buf(saved->params)));
	} else if (lt::alert_cast<lt::save_resume_data_failed_alert>(alert)) {
		object.Set("type", "resume_data_failed");
		object.Set("message", alert->message());
	} else if (auto *renamed = lt::alert_cast<lt::file_renamed_alert>(alert)) {
		object.Set("type", "renamed");
		object.Set("index", static_cast<int>(renamed->index));
		object.Set("name", renamed->new_name());
	} else if (auto *failed = lt::alert_cast<lt::file_rename_failed_alert>(alert)) {
		object.Set("type", "rename_failed");
		object.Set("index", static_cast<int>(failed->index));
		object.Set("message", alert->message());
	} else if (lt::alert_cast<lt::torrent_removed_alert>(alert)) {
		object.Set("type", "removed");
		torrents.erase(*id);
	} else if (alert->category() & lt::alert_category::error) {
		object.Set("type", "warning");
		object.Set("message", alert->message());
	} else
		return env.Undefined();

	return object;
}

Napi::Value Session::Add(const CallbackInfo &args) {
	Napi::Env env = args.Env();

	if (!session)
		throw Error::New(env, "Session is closed");

	if (!args[0].IsObject())
		throw TypeError::New(env, "Options must be an object");

	Object options = args[0].As<Object>();
	Napi::Value source = options.Get("source"), resume = options.Get("resume"), directory = options.Get("directory");

	lt::add_torrent_params params;

	if (resume.IsTypedArray())
		params = lt::read_resume_data(toSpan(resume));
	else if (source.IsString())
		params = lt::parse_magnet_uri(source.As<String>().Utf8Value());
	else if (source.IsTypedArray())
		params = lt::load_torrent_buffer(toSpan(source));
	else
		throw TypeError::New(env, "A magnet link, torrent file, or resume data is required");

	if (directory.IsString())
		params.save_path = directory.As<String>();
	else if (params.save_path.empty())
		throw TypeError::New(env, "A directory is required");

	// Nothing is downloaded until files are selected
	params.flags |= lt::torrent_flags::default_dont_download;

	// Resume data doesn't keep this, and status updates depend on it
	params.flags |= lt::torrent_flags::update_subscribe;

	if (options.Get("paused").ToBoolean()) {
		params.flags |= lt::torrent_flags::paused;
		params.flags &= ~lt::torrent_flags::auto_managed;
	}

	std::string id = idFor(params.ti ? params.ti->info_hashes() : params.info_hashes);
	if (torrents.contains(id))
		throw Error::New(env, "Torrent " + id + " has already been added");

	torrents.emplace(id, session->add_torrent(std::move(params)));

	return String::New(env, id);
}

Napi::Value Session::Files(const CallbackInfo &args) {
	Napi::Env env = args.Env();
	const lt::torrent_handle &handle = find(args[0]);

	std::shared_ptr<const lt::torrent_info> info = handle.torrent_file();
	if (!info)
		return env.Null();

	const lt::file_storage &storage = info->files();
	std::vector<lt::download_priority_t> priorities = handle.get_file_priorities();

	Array files = Array::New(env);

	for (lt::file_index_t index : storage.file_range()) {
		if (storage.pad_file_at(index))
			continue;

		auto position = static_cast<std::size_t>(static_cast<int>(index));

		Object file = Object::New(env);
		file.Set("index", static_cast<int>(index));
		file.Set("path", storage.file_path(index));
		file.Set("size", static_cast<double>(storage.file_size(index)));
		file.Set("selected", position < priorities.size() && priorities[position] != lt::dont_download);
		files.Set(files.Length(), file);
	}

	return files;
}

Napi::Value Session::Select(const CallbackInfo &args) {
	Napi::Env env = args.Env();
	const lt::torrent_handle &handle = find(args[0]);

	if (!args[1].IsArray())
		throw TypeError::New(env, "File indices must be an array");

	Array indices = args[1].As<Array>();
	int count = requireMetadata(env, handle)->num_files();

	std::vector<lt::download_priority_t> priorities(static_cast<std::size_t>(count), lt::dont_download);

	for (std::uint32_t i = 0; i < indices.Length(); i++)
		priorities[static_cast<std::size_t>(toIndex(indices.Get(i), count))] = lt::default_priority;

	handle.prioritize_files(priorities);

	return env.Undefined();
}

Napi::Value Session::Rename(const CallbackInfo &args) {
	Napi::Env env = args.Env();
	const lt::torrent_handle &handle = find(args[0]);

	int index = toIndex(args[1], requireMetadata(env, handle)->num_files());

	if (!args[2].IsString())
		throw TypeError::New(env, "File name must be a string");

	handle.rename_file(lt::file_index_t(index), args[2].As<String>());

	return env.Undefined();
}

Napi::Value Session::Pause(const CallbackInfo &args) {
	const lt::torrent_handle &handle = find(args[0]);

	// Otherwise the queue would start it again
	handle.unset_flags(lt::torrent_flags::auto_managed);
	handle.pause();

	return args.Env().Undefined();
}

Napi::Value Session::Resume(const CallbackInfo &args) {
	const lt::torrent_handle &handle = find(args[0]);

	handle.set_flags(lt::torrent_flags::auto_managed);
	handle.resume();

	return args.Env().Undefined();
}

Napi::Value Session::SaveResumeData(const CallbackInfo &args) {
	// Includes the metadata, so a magnet link doesn't have to fetch it again
	find(args[0]).save_resume_data(lt::torrent_handle::save_info_dict);

	return args.Env().Undefined();
}

Napi::Value Session::Remove(const CallbackInfo &args) {
	const lt::torrent_handle &handle = find(args[0]);

	session->remove_torrent(handle, args[1].ToBoolean() ? lt::session::delete_files : lt::remove_flags_t{});

	return args.Env().Undefined();
}

Napi::Value Session::Status(const CallbackInfo &args) {
	const lt::torrent_handle &handle = find(args[0]);

	return fromStatus(args.Env(), args[0].As<String>(), handle.status());
}

Napi::Value Session::PostUpdates(const CallbackInfo &args) {
	if (session)
		session->post_torrent_updates();

	return args.Env().Undefined();
}

Napi::Value Session::Alerts(const CallbackInfo &args) {
	Napi::Env env = args.Env();
	Array result = Array::New(env);

	if (!session)
		return result;

	std::vector<lt::alert *> alerts;
	session->pop_alerts(&alerts);

	for (const lt::alert *alert : alerts) {
		Napi::Value value = fromAlert(env, alert);
		if (!value.IsUndefined())
			result.Set(result.Length(), value);
	}

	return result;
}

Napi::Value Session::ApplySettings(const CallbackInfo &args) {
	Napi::Env env = args.Env();

	if (!session)
		throw Error::New(env, "Session is closed");

	if (!args[0].IsObject())
		throw TypeError::New(env, "Settings must be an object");

	session->apply_settings(toSettings(args[0].As<Object>()));

	return env.Undefined();
}

Napi::Value Session::Close(const CallbackInfo &args) {
	close();
	return args.Env().Undefined();
}
