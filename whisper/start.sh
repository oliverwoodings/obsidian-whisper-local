#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE_FILE="${SCRIPT_DIR}/.env.example"

if [[ ! -f "${ENV_FILE}" ]]; then
	cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
	echo "Created ${ENV_FILE} from ${ENV_EXAMPLE_FILE}."
	echo "Run npm run whisper:setup first."
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

WHISPER_SRC_DIR="${WHISPER_SRC_DIR:-./whisper/whisper.cpp-src}"
WHISPER_BUILD_DIR="${WHISPER_BUILD_DIR:-./whisper/build}"
WHISPER_MODEL="${WHISPER_MODEL:-base.en}"
WHISPER_MODEL_FILE="${WHISPER_MODEL_FILE:-ggml-${WHISPER_MODEL}.bin}"
WHISPER_MODEL_DIR="${WHISPER_MODEL_DIR:-./whisper/models}"
WHISPER_HOST="${WHISPER_HOST:-127.0.0.1}"
WHISPER_PORT="${WHISPER_PORT:-8080}"
WHISPER_SERVER_ARGS="${WHISPER_SERVER_ARGS:-}"
WHISPER_DETACH="${WHISPER_DETACH:-1}"
WHISPER_LOG_FILE="${WHISPER_LOG_FILE:-./whisper/whisper-server.log}"
WHISPER_PID_FILE="${WHISPER_PID_FILE:-./whisper/whisper-server.pid}"

resolve_path() {
	local value="$1"
	if [[ "${value}" == /* ]]; then
		printf '%s\n' "${value}"
	else
		printf '%s\n' "${REPO_ROOT}/${value#./}"
	fi
}

find_server_binary() {
	local build_dir="$1"
	local src_dir="$2"
	local candidates=(
		"${build_dir}/bin/whisper-server"
		"${build_dir}/bin/Release/whisper-server"
		"${build_dir}/Release/bin/whisper-server"
		"${src_dir}/build/bin/whisper-server"
	)

	for candidate in "${candidates[@]}"; do
		if [[ -x "${candidate}" ]]; then
			printf '%s\n' "${candidate}"
			return 0
		fi
	done

	return 1
}

stop_existing_process() {
	local pid_file="$1"
	if [[ ! -f "${pid_file}" ]]; then
		return 0
	fi

	local existing_pid
	existing_pid="$(cat "${pid_file}" 2>/dev/null || true)"
	if [[ -z "${existing_pid}" ]]; then
		rm -f "${pid_file}"
		return 0
	fi

	if kill -0 "${existing_pid}" >/dev/null 2>&1; then
		echo "Stopping existing whisper-server process: ${existing_pid}"
		kill "${existing_pid}" >/dev/null 2>&1 || true
		sleep 1
		if kill -0 "${existing_pid}" >/dev/null 2>&1; then
			kill -9 "${existing_pid}" >/dev/null 2>&1 || true
		fi
	fi

	rm -f "${pid_file}"
}

WHISPER_SRC_DIR="$(resolve_path "${WHISPER_SRC_DIR}")"
WHISPER_BUILD_DIR="$(resolve_path "${WHISPER_BUILD_DIR}")"
WHISPER_MODEL_DIR="$(resolve_path "${WHISPER_MODEL_DIR}")"
WHISPER_LOG_FILE="$(resolve_path "${WHISPER_LOG_FILE}")"
WHISPER_PID_FILE="$(resolve_path "${WHISPER_PID_FILE}")"

SERVER_BIN="$(find_server_binary "${WHISPER_BUILD_DIR}" "${WHISPER_SRC_DIR}" || true)"
if [[ -z "${SERVER_BIN}" ]]; then
	echo "whisper-server binary not found." >&2
	echo "Run npm run whisper:setup first." >&2
	exit 1
fi

MODEL_PATH="${WHISPER_MODEL_DIR}/${WHISPER_MODEL_FILE}"
if [[ ! -f "${MODEL_PATH}" ]]; then
	echo "Model file not found: ${MODEL_PATH}" >&2
	echo "Run npm run whisper:setup first (or edit whisper/.env)." >&2
	exit 1
fi

mkdir -p "$(dirname "${WHISPER_LOG_FILE}")"
mkdir -p "$(dirname "${WHISPER_PID_FILE}")"
stop_existing_process "${WHISPER_PID_FILE}"

cmd=(
	"${SERVER_BIN}"
	"--host" "${WHISPER_HOST}"
	"--port" "${WHISPER_PORT}"
	"-m" "${MODEL_PATH}"
)

if [[ -n "${WHISPER_SERVER_ARGS}" ]]; then
	# shellcheck disable=SC2206
	extra_args=(${WHISPER_SERVER_ARGS})
	cmd+=("${extra_args[@]}")
fi

echo "Starting whisper.cpp server..."
echo "- binary: ${SERVER_BIN}"
echo "- model: ${MODEL_PATH}"
echo "- url: http://${WHISPER_HOST}:${WHISPER_PORT}"
echo "- detached: ${WHISPER_DETACH}"

if [[ "${WHISPER_DETACH}" == "1" ]]; then
	nohup "${cmd[@]}" >>"${WHISPER_LOG_FILE}" 2>&1 &
	server_pid="$!"
	echo "${server_pid}" > "${WHISPER_PID_FILE}"
	sleep 1
	if ! kill -0 "${server_pid}" >/dev/null 2>&1; then
		echo "whisper-server exited immediately. Check logs:" >&2
		echo "  ${WHISPER_LOG_FILE}" >&2
		exit 1
	fi

	echo ""
	echo "whisper.cpp server started in detached mode."
	echo "- pid: ${server_pid}"
	echo "- pid file: ${WHISPER_PID_FILE}"
	echo "- logs: npm run whisper:logs"
	echo "- stop: npm run whisper:stop"
	exit 0
fi

exec "${cmd[@]}"
