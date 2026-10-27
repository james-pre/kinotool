#pragma once

#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include "common.hxx"

/** Wakes up JS from libtorrent's threads when alerts are waiting */
class AlertNotifier final {
  public:
	static std::shared_ptr<AlertNotifier> create(const Napi::Env &env, const Function &callback);

	void notify();
	void close();

  private:
	std::mutex mutex;
	bool closed = false;
	ThreadSafeFunction function;
};

class Session final : public ObjectWrap<Session> {
  public:
	static Function Define(Napi::Env env);

	Session(const CallbackInfo &args);
	~Session() override;

  private:
	std::unique_ptr<lt::session> session;
	std::shared_ptr<AlertNotifier> notifier;

	/** Torrents by the ID they were given when added. Removed torrents stay until their removal alert. */
	std::map<std::string, lt::torrent_handle> torrents;

	const lt::torrent_handle &find(const Napi::Value &id);
	std::optional<std::string> idOf(const lt::torrent_handle &handle) const;
	Napi::Value fromAlert(const Napi::Env &env, const lt::alert *alert);

	Napi::Value Add(const CallbackInfo &args);
	Napi::Value Files(const CallbackInfo &args);
	Napi::Value Select(const CallbackInfo &args);
	Napi::Value Rename(const CallbackInfo &args);
	Napi::Value Pause(const CallbackInfo &args);
	Napi::Value Resume(const CallbackInfo &args);
	Napi::Value SaveResumeData(const CallbackInfo &args);
	Napi::Value Remove(const CallbackInfo &args);
	Napi::Value Status(const CallbackInfo &args);
	Napi::Value PostUpdates(const CallbackInfo &args);
	Napi::Value Alerts(const CallbackInfo &args);
	Napi::Value ApplySettings(const CallbackInfo &args);
	Napi::Value Close(const CallbackInfo &args);

	void close();
};
