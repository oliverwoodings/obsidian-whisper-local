#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE_FILE="${SCRIPT_DIR}/.env.example"

ensure_env_file() {
	if [[ ! -f "${ENV_FILE}" ]]; then
		cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
		echo "Created ${ENV_FILE} from ${ENV_EXAMPLE_FILE}."
	fi
}

load_env() {
	ensure_env_file
	set -a
	# shellcheck disable=SC1090
	source "${ENV_FILE}"
	set +a
}

resolve_path() {
	local value="$1"
	local expanded="${value/#\~/$HOME}"
	if [[ "${expanded}" == /* ]]; then
		printf '%s\n' "${expanded}"
	else
		printf '%s\n' "${REPO_ROOT}/${expanded#./}"
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

require_command() {
	local command_name="$1"
	if ! command -v "${command_name}" >/dev/null 2>&1; then
		echo "Missing required command: ${command_name}" >&2
		exit 1
	fi
}

xml_escape() {
	local value="$1"
	value="${value//&/&amp;}"
	value="${value//</&lt;}"
	value="${value//>/&gt;}"
	value="${value//\"/&quot;}"
	value="${value//\'/&apos;}"
	printf '%s' "${value}"
}

launchd_target() {
	local uid
	uid="$(id -u)"
	printf 'gui/%s' "${uid}"
}

load_runtime_settings() {
	WHISPER_SRC_DIR="$(resolve_path "${WHISPER_SRC_DIR:-./whisper/whisper.cpp-src}")"
	WHISPER_BUILD_DIR="$(resolve_path "${WHISPER_BUILD_DIR:-./whisper/build}")"
	WHISPER_MODEL_DIR="$(resolve_path "${WHISPER_MODEL_DIR:-./whisper/models}")"
	WHISPER_MODEL="${WHISPER_MODEL:-base.en}"
	WHISPER_MODEL_FILE="${WHISPER_MODEL_FILE:-ggml-${WHISPER_MODEL}.bin}"
	WHISPER_HOST="${WHISPER_HOST:-127.0.0.1}"
	WHISPER_PORT="${WHISPER_PORT:-8080}"
	WHISPER_SERVER_ARGS="${WHISPER_SERVER_ARGS:-}"

	WHISPER_LAUNCHD_LABEL="${WHISPER_LAUNCHD_LABEL:-io.obsidian.whisper-local.server}"
	WHISPER_LAUNCHD_PLIST="$(resolve_path "${WHISPER_LAUNCHD_PLIST:-~/Library/LaunchAgents/${WHISPER_LAUNCHD_LABEL}.plist}")"
	WHISPER_LAUNCHD_RUN_AT_LOAD="${WHISPER_LAUNCHD_RUN_AT_LOAD:-1}"
	WHISPER_LAUNCHD_KEEP_ALIVE="${WHISPER_LAUNCHD_KEEP_ALIVE:-1}"
	WHISPER_STDOUT_LOG="$(resolve_path "${WHISPER_STDOUT_LOG:-./whisper/whisper-server.log}")"
	WHISPER_STDERR_LOG="$(resolve_path "${WHISPER_STDERR_LOG:-./whisper/whisper-server.error.log}")"
}

load_runtime() {
	load_env
	load_runtime_settings
}

build_server_command() {
	local server_bin="$1"
	local model_path="$2"
	SERVER_COMMAND_ARGS=(
		"${server_bin}"
		"--host" "${WHISPER_HOST}"
		"--port" "${WHISPER_PORT}"
		"-m" "${model_path}"
	)

	if [[ -n "${WHISPER_SERVER_ARGS}" ]]; then
		local extra_args=()
		# shellcheck disable=SC2206
		extra_args=(${WHISPER_SERVER_ARGS})
		SERVER_COMMAND_ARGS+=("${extra_args[@]}")
	fi
}

resolve_runtime_artifacts() {
	SERVER_BIN="$(find_server_binary "${WHISPER_BUILD_DIR}" "${WHISPER_SRC_DIR}" || true)"
	MODEL_PATH="${WHISPER_MODEL_DIR}/${WHISPER_MODEL_FILE}"
}

assert_runtime_ready() {
	resolve_runtime_artifacts
	if [[ -z "${SERVER_BIN}" ]]; then
		echo "whisper-server binary not found." >&2
		echo "Run npm run whisper:setup first." >&2
		exit 1
	fi

	if [[ ! -f "${MODEL_PATH}" ]]; then
		echo "Model file not found: ${MODEL_PATH}" >&2
		echo "Run npm run whisper:setup first (or edit whisper/.env)." >&2
		exit 1
	fi
}

bool_xml_tag() {
	local value="$1"
	local lower_value
	lower_value="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
	if [[ "${value}" == "1" || "${lower_value}" == "true" ]]; then
		printf '<true/>'
	else
		printf '<false/>'
	fi
}
