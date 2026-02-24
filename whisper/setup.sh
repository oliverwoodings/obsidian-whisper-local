#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

WHISPER_REPO_URL_DEFAULT="https://github.com/ggml-org/whisper.cpp.git"
WHISPER_REPO_REF_DEFAULT="main"

cpu_count() {
	if command -v nproc >/dev/null 2>&1; then
		nproc
		return
	fi

	if command -v sysctl >/dev/null 2>&1; then
		sysctl -n hw.logicalcpu
		return
	fi

	echo 4
}

ensure_repo_checked_out() {
	local src_dir="$1"
	local repo_url="$2"
	local repo_ref="$3"

	if [[ ! -d "${src_dir}/.git" ]]; then
		echo "Cloning whisper.cpp (${repo_ref}) into ${src_dir}"
		if ! git clone --depth 1 --branch "${repo_ref}" "${repo_url}" "${src_dir}"; then
			if [[ "${repo_ref}" == "main" ]]; then
				echo "Falling back to branch 'master'..."
				git clone --depth 1 --branch "master" "${repo_url}" "${src_dir}"
			else
				return 1
			fi
		fi
		return 0
	fi

	echo "Using existing whisper.cpp checkout: ${src_dir}"
}

main() {
	load_runtime

	local whisper_repo_url="${WHISPER_REPO_URL:-${WHISPER_REPO_URL_DEFAULT}}"
	local whisper_repo_ref="${WHISPER_REPO_REF:-${WHISPER_REPO_REF_DEFAULT}}"
	local whisper_model_url="${WHISPER_MODEL_URL:-}"
	if [[ -z "${whisper_model_url}" ]]; then
		whisper_model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_FILE}"
	fi

	require_command git
	require_command cmake
	require_command curl

	mkdir -p "${WHISPER_MODEL_DIR}"
	ensure_repo_checked_out "${WHISPER_SRC_DIR}" "${whisper_repo_url}" "${whisper_repo_ref}"

	echo "Configuring whisper.cpp build..."
	cmake -S "${WHISPER_SRC_DIR}" -B "${WHISPER_BUILD_DIR}" \
		-DCMAKE_BUILD_TYPE=Release \
		-DWHISPER_BUILD_EXAMPLES=ON

	echo "Building whisper.cpp (this may take a few minutes)..."
	cmake --build "${WHISPER_BUILD_DIR}" --config Release -j "$(cpu_count)"

	assert_runtime_ready

	if [[ -f "${MODEL_PATH}" ]]; then
		echo "Model already present: ${MODEL_PATH}"
	else
		echo "Downloading model: ${WHISPER_MODEL_FILE}"
		echo "Source: ${whisper_model_url}"
		curl -fL --progress-bar "${whisper_model_url}" -o "${MODEL_PATH}"
		echo "Model downloaded to: ${MODEL_PATH}"
	fi

	echo "Installing launchd service definition..."
	"${SCRIPT_DIR}/service-install.sh"

	cat <<MSG

whisper.cpp native setup complete.

Current configuration:
- env file: ${ENV_FILE}
- source dir: ${WHISPER_SRC_DIR}
- build dir: ${WHISPER_BUILD_DIR}
- server binary: ${SERVER_BIN}
- model: ${MODEL_PATH}
- launchd label: ${WHISPER_LAUNCHD_LABEL}
- launchd plist: ${WHISPER_LAUNCHD_PLIST}
- server URL for plugin settings: http://${WHISPER_HOST}:${WHISPER_PORT}

Service management:
- start: npm run whisper:start
- stop: npm run whisper:stop
- status: npm run whisper:status
- logs: npm run whisper:logs
- uninstall launchd service: npm run whisper:uninstall

MSG
}

main "$@"
