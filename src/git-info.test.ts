import { describe, it, expect } from "vitest";
import { normalizeRemoteUrl } from "./git-info.js";

describe("normalizeRemoteUrl", () => {
  it("parses SCP-style GitHub SSH with .git suffix", () => {
    expect(normalizeRemoteUrl("git@github.com:acme/api.git")).toBe("github.com/acme/api");
  });

  it("parses SCP-style GitHub SSH without .git suffix", () => {
    expect(normalizeRemoteUrl("git@github.com:acme/api")).toBe("github.com/acme/api");
  });

  it("parses HTTPS GitHub URL with .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/api.git")).toBe("github.com/acme/api");
  });

  it("parses HTTPS GitHub URL without .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/api")).toBe("github.com/acme/api");
  });

  it("parses GitLab nested groups via HTTPS", () => {
    expect(normalizeRemoteUrl("https://gitlab.com/acme/platform/api.git")).toBe("gitlab.com/acme/platform/api");
  });

  it("parses GitLab nested groups via SCP", () => {
    expect(normalizeRemoteUrl("git@gitlab.com:acme/platform/api.git")).toBe("gitlab.com/acme/platform/api");
  });

  it("parses Bitbucket SSH URL", () => {
    expect(normalizeRemoteUrl("ssh://git@bitbucket.org/acme/api.git")).toBe("bitbucket.org/acme/api");
  });

  it("parses self-hosted GitLab with custom host", () => {
    expect(normalizeRemoteUrl("git@gitlab.internal.corp:team/service.git")).toBe("gitlab.internal.corp/team/service");
  });

  it("strips trailing slash from URL paths", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/api/")).toBe("github.com/acme/api");
  });

  it("strips .git and trailing slash together", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/api.git/")).toBe("github.com/acme/api");
  });

  it("returns null for unparseable URL", () => {
    expect(normalizeRemoteUrl("not a url at all")).toBeNull();
  });

  it("returns null for empty-ish URL", () => {
    expect(normalizeRemoteUrl("")).toBeNull();
  });
});
