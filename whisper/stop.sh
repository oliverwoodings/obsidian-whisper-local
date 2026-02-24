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

WHISPER_PID_FILE="${WHISPER_PID_FILE:-./whisper/whisper-server.pid}"

resolve_path() {
	local value="$1"
	if [[ "${value}" == /* ]]; then
		printf '%s\n' "${value}"
	else
		printf '%s\n' "${REPO_ROOT}/${value#./}"
	fi
}

WHISPER_PID_FILE="$(resolve_path "${WHISPER_PID_FILE}")"

if [[ ! -f "${WHISPER_PID_FILE}" ]]; then
	echo "No pid file found at ${WHISPER_PID_FILE}. whisper-server may already be stopped."
	exit 0
fi

PID="$(cat "${WHISPER_PID_FILE}" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
	rm -f "${WHISPER_PID_FILE}"
	echo "Pid file was empty. Removed stale pid file."
	exit 0
fi

if ! kill -0 "${PID}" >/dev/null 2>&1; then
	rm -f "${WHISPER_PID_FILE}"
	echo "whisper-server process ${PID} is not running. Removed stale pid file."
	exit 0
fi

echo "Stopping whisper-server process ${PID}..."
kill "${PID}" >/dev/null 2>&1 || true

for _ in {1..20}; do
	if ! kill -0 "${PID}" >/dev/null 2>&1; then
		rm -f "${WHISPER_PID_FILE}"
		echo "whisper-server stopped."
		exit 0
	fi
	sleep 0.25
done

echo "Process ${PID} did not exit gracefully, sending SIGKILL..."
kill -9 "${PID}" >/dev/null 2>&1 || true
rm -f "${WHISPER_PID_FILE}"
echo "whisper-server stopped."
