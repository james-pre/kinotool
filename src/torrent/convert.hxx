#pragma once

#include "common.hxx"

std::string toHex(const lt::sha1_hash &hash);

Object fromStatus(const Env &env, const std::string &id, const lt::torrent_status &status);

Uint8Array fromBuffer(const Env &env, const std::vector<char> &buffer);

lt::settings_pack toSettings(const Object &object);
