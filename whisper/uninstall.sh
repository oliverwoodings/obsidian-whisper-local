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

	if [[ -f "${WHISPER_LAUNCHD_PLIST}" ]]; then
		launchctl bootout "${target}" "${WHISPER_LAUNCHD_PLIST}" >/dev/null 2>&1 || true
		rm -f "${WHISPER_LAUNCHD_PLIST}"
	else
		launchctl bootout "${service_target}" >/dev/null 2>&1 || true
	fi

	echo "whisper.cpp launchd service uninstalled."
	echo "- label: ${WHISPER_LAUNCHD_LABEL}"
	echo "- plist removed: ${WHISPER_LAUNCHD_PLIST}"
	echo "- logs retained:"
	echo "  ${WHISPER_STDOUT_LOG}"
	echo "  ${WHISPER_STDERR_LOG}"
}

main "$@"
