import { describe, expect, it } from "vitest";
import { parsePosix, parsePowershell, type SimpleCommand, unknownMark } from "./shell.js";

function words(commands: readonly SimpleCommand[]): string[][] {
  return commands.map((command) => command.words.map((word) => word.text));
}

describe("reading POSIX shell text", () => {
  it("splits on operators and newlines and removes quotes", () => {
    const commands = parsePosix("a 'b c' \"d e\" f\\ g && h; i | j || k & l\nm");
    expect(words(commands)).toEqual([["a", "b c", "d e", "f g"], ["h"], ["i"], ["j"], ["k"], ["l"], ["m"]]);
    expect(commands.map((command) => command.pipedIn)).toEqual([false, false, false, true, false, false, false]);
  });

  it("marks expansions as unknown and keeps substitutions to read them too", () => {
    const [command] = parsePosix('rm -rf "$HOME/x" $(echo y) `echo z`');
    expect(command?.words.map((word) => [word.text, word.dynamic])).toEqual([
      ["rm", false],
      ["-rf", false],
      [`${unknownMark}/x`, true],
      [unknownMark, true],
      [unknownMark, true],
    ]);
    expect(command?.nested).toEqual(["echo y", "echo z"]);
  });

  it("reads redirections and here-documents", () => {
    const [command, after] = parsePosix("psql -U x 2>&1 >> out.log <<'SQL'\nDROP DATABASE a;\nSQL\necho done");
    expect(command?.words.map((word) => word.text)).toEqual(["psql", "-U", "x"]);
    expect(command?.redirects.map((redirect) => [redirect.operator, redirect.target?.text, redirect.heredoc])).toEqual([
      [">>", "out.log", undefined],
      ["<<", "SQL", "DROP DATABASE a;"],
    ]);
    expect(after?.words.map((word) => word.text)).toEqual(["echo", "done"]);
  });

  it("keeps the backslashes of a Windows path and skips comments", () => {
    expect(words(parsePosix("rm -r C:\\data\\x # rm -rf /"))).toEqual([["rm", "-r", "C:\\data\\x"]]);
  });

  it("reads a subshell as a script of its own", () => {
    const [command, next] = parsePosix("(cd /x && rm -rf y); ls");
    expect(command?.nested).toEqual(["cd /x && rm -rf y"]);
    expect(next?.words.map((word) => word.text)).toEqual(["ls"]);
  });
});

describe("reading PowerShell text", () => {
  it("splits on operators, keeps backslashes and splits arrays", () => {
    expect(words(parsePowershell("Remove-Item C:\\a, 'C:\\b c' -Recurse; Get-Item x | Out-Null"))).toEqual([
      ["Remove-Item", "C:\\a", "C:\\b c", "-Recurse"],
      ["Get-Item", "x"],
      ["Out-Null"],
    ]);
  });

  it("reads script blocks and subexpressions as scripts of their own", () => {
    const [command] = parsePowershell("Get-ChildItem | ForEach-Object { Remove-Item $_ } ; Write-Output \"$(whoami)\"");
    expect(command?.words.map((word) => word.text)).toEqual(["Get-ChildItem"]);
    const commands = parsePowershell("ForEach-Object { Remove-Item $_ }; Write-Output \"$(whoami)\"");
    expect(commands[0]?.nested).toEqual([" Remove-Item $_ "]);
    expect(commands[1]?.nested).toEqual(["whoami"]);
  });

  it("reads quotes, escapes and the stop-parsing token", () => {
    expect(words(parsePowershell("echo 'it''s' \"a`\"b\" `$x; cmd --% /c del /q x"))).toEqual([
      ["echo", "it's", 'a"b', "$x"],
      ["cmd", "/c", "del", "/q", "x"],
    ]);
  });
});
