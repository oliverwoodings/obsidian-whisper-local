#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

main() {
	local no_start=0
	for arg in "$@"; do
		case "${arg}" in
			--no-start)
				no_start=1
				;;
			*)
				echo "Unknown option: ${arg}" >&2
				echo "Usage: ${0} [--no-start]" >&2
				exit 1
				;;
		esac
	done

	load_runtime
	assert_runtime_ready
	require_command launchctl

	local target service_target
	target="$(launchd_target)"
	service_target="${target}/${WHISPER_LAUNCHD_LABEL}"

	build_server_command "${SERVER_BIN}" "${MODEL_PATH}"

	mkdir -p "$(dirname "${WHISPER_LAUNCHD_PLIST}")"
	mkdir -p "$(dirname "${WHISPER_STDOUT_LOG}")" "$(dirname "${WHISPER_STDERR_LOG}")"
	touch "${WHISPER_STDOUT_LOG}" "${WHISPER_STDERR_LOG}"

	{
		echo '<?xml version="1.0" encoding="UTF-8"?>'
		echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
		echo '<plist version="1.0">'
		echo '<dict>'
		echo '  <key>Label</key>'
		echo "  <string>$(xml_escape "${WHISPER_LAUNCHD_LABEL}")</string>"
		echo '  <key>ProgramArguments</key>'
		echo '  <array>'
		for arg in "${SERVER_COMMAND_ARGS[@]}"; do
			echo "    <string>$(xml_escape "${arg}")</string>"
		done
		echo '  </array>'
		echo '  <key>WorkingDirectory</key>'
		echo "  <string>$(xml_escape "${REPO_ROOT}")</string>"
		echo '  <key>RunAtLoad</key>'
		echo "  $(bool_xml_tag "${WHISPER_LAUNCHD_RUN_AT_LOAD}")"
		echo '  <key>KeepAlive</key>'
		echo "  $(bool_xml_tag "${WHISPER_LAUNCHD_KEEP_ALIVE}")"
		echo '  <key>StandardOutPath</key>'
		echo "  <string>$(xml_escape "${WHISPER_STDOUT_LOG}")</string>"
		echo '  <key>StandardErrorPath</key>'
		echo "  <string>$(xml_escape "${WHISPER_STDERR_LOG}")</string>"
		echo '</dict>'
		echo '</plist>'
	} > "${WHISPER_LAUNCHD_PLIST}"

	launchctl bootout "${target}" "${WHISPER_LAUNCHD_PLIST}" >/dev/null 2>&1 || true
	launchctl bootstrap "${target}" "${WHISPER_LAUNCHD_PLIST}" >/dev/null
	launchctl enable "${service_target}" >/dev/null 2>&1 || true

	if [[ "${no_start}" == "0" ]]; then
		launchctl kickstart -k "${service_target}" >/dev/null
	fi

	echo "whisper.cpp launchd service installed."
	echo "- label: ${WHISPER_LAUNCHD_LABEL}"
	echo "- plist: ${WHISPER_LAUNCHD_PLIST}"
	echo "- url: http://${WHISPER_HOST}:${WHISPER_PORT}"
	if [[ "${no_start}" == "1" ]]; then
		echo "- state: installed (not started)"
	else
		echo "- state: running"
	fi
}

main "$@"
