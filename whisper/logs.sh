#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

main() {
	load_runtime

	local stdout_log="${WHISPER_STDOUT_LOG}"
	local stderr_log="${WHISPER_STDERR_LOG}"

	mkdir -p "$(dirname "${stdout_log}")" "$(dirname "${stderr_log}")"
	touch "${stdout_log}" "${stderr_log}"

	echo "Streaming whisper.cpp launchd logs:"
	echo "- stdout: ${stdout_log}"
	echo "- stderr: ${stderr_log}"
	tail -n 200 -f "${stdout_log}" "${stderr_log}"
}

main "$@"
