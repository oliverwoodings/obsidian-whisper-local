#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE_FILE="${SCRIPT_DIR}/.env.example"

if [[ -f "${ENV_FILE}" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "${ENV_FILE}"
	set +a
elif [[ -f "${ENV_EXAMPLE_FILE}" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "${ENV_EXAMPLE_FILE}"
	set +a
fi

WHISPER_LOG_FILE="${WHISPER_LOG_FILE:-./whisper/whisper-server.log}"

resolve_path() {
	local value="$1"
	if [[ "${value}" == /* ]]; then
		printf '%s\n' "${value}"
	else
		printf '%s\n' "${REPO_ROOT}/${value#./}"
	fi
}

WHISPER_LOG_FILE="$(resolve_path "${WHISPER_LOG_FILE}")"

if [[ ! -f "${WHISPER_LOG_FILE}" ]]; then
	echo "Log file not found: ${WHISPER_LOG_FILE}" >&2
	echo "Start the server first: npm run whisper:start" >&2
	exit 1
fi

echo "Streaming whisper-server logs from ${WHISPER_LOG_FILE}"
tail -n 200 -f "${WHISPER_LOG_FILE}"
