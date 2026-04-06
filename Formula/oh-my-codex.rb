class OhMyCodex < Formula
  desc "Multi-agent orchestration layer for OpenAI Codex CLI"
  homepage "https://yeachan-heo.github.io/oh-my-codex"
  url "https://registry.npmjs.org/oh-my-codex/-/oh-my-codex-0.11.13.tgz"
  sha256 "ab6defdacac3f0eea704f024aa9c18ab43b351bf55e14618d9317ea866b71c94"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/omx --version")
  end
end
