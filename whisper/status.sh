#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

main() {
	load_runtime
	require_command launchctl

	local target service_target
	target="$(launchd_target)"
	service_target="${target}/${WHISPER_LAUNCHD_LABEL}"

	echo "whisper.cpp launchd status"
	echo "- label: ${WHISPER_LAUNCHD_LABEL}"
	echo "- target: ${service_target}"
	echo "- plist: ${WHISPER_LAUNCHD_PLIST}"
	echo "- url: http://${WHISPER_HOST}:${WHISPER_PORT}"
	echo "- stdout log: ${WHISPER_STDOUT_LOG}"
	echo "- stderr log: ${WHISPER_STDERR_LOG}"
	echo ""

	if ! launchctl print "${service_target}" >/dev/null 2>&1; then
		echo "Service is not loaded in launchd."
		exit 0
	fi

	launchctl print "${service_target}"
}

main "$@"
