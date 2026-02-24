#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

main() {
	load_runtime
	assert_runtime_ready
	require_command launchctl

	local target service_target
	target="$(launchd_target)"
	service_target="${target}/${WHISPER_LAUNCHD_LABEL}"

	if [[ ! -f "${WHISPER_LAUNCHD_PLIST}" ]]; then
		echo "Launchd plist not found: ${WHISPER_LAUNCHD_PLIST}" >&2
		echo "Run npm run whisper:setup first." >&2
		exit 1
	fi

	if ! launchctl print "${service_target}" >/dev/null 2>&1; then
		launchctl bootstrap "${target}" "${WHISPER_LAUNCHD_PLIST}" >/dev/null
	fi

	launchctl enable "${service_target}" >/dev/null 2>&1 || true
	launchctl kickstart -k "${service_target}" >/dev/null

	echo "whisper.cpp launchd service started."
	echo "- label: ${WHISPER_LAUNCHD_LABEL}"
	echo "- url: http://${WHISPER_HOST}:${WHISPER_PORT}"
	echo "- status: npm run whisper:status"
}

main "$@"
