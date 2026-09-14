# Template rendered by scripts/release.sh; do not audit this file directly.
class Megabrain < Formula
  desc "Tooling for Git worktrees, agent orchestration, and device testing"
  homepage "https://github.com/oguilhermelima/megabrain"
  url "https://github.com/oguilhermelima/megabrain/releases/download/v0.2.4/megabrain-0.2.4.tar.gz"
  sha256 "36b81dc6b99a600d5eee3b9fcb6a29963bbb1f6b9548e1ad447e21a2a4ea912e"
  license "MIT"

  depends_on "jq"

  def install
    libexec.install Dir["*"]
    libexec.install ".agents", ".claude-plugin", ".codex-plugin", ".megabrain"
    bin.install_symlink libexec/"megabrain"
    bin.install_symlink libexec/"mb"
  end

  def caveats
    <<~EOS
      Homebrew installs the megabrain CLI. Run `megabrain install` for machine setup.
      The megabrain skill is kept in sync by megabrain itself.
    EOS
  end

  test do
    assert_match(/^megabrain [0-9]+\.[0-9]+\.[0-9]+$/, shell_output("#{bin}/megabrain version"))
  end
end
