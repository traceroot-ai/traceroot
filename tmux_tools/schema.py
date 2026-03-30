"""Declarative schema for defining development configurations."""

import os
import re
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from shlex import quote
from subprocess import CompletedProcess

from tmux_tools import tmux


@dataclass
class CheckResult:
    succeeded: bool
    message: str


@dataclass
class Prerequisite:
    name: str
    command: str | Sequence[str] | None = None
    instructions: str = ""
    expected_output: str | None = None
    check_fn: Callable[[], CheckResult] | None = None

    def _check_cmd_output(self, cmd_output: CompletedProcess) -> bool:
        return (
            cmd_output.returncode == 0
            and (not self.expected_output or re.search(self.expected_output, cmd_output.stdout))
            is not None
        )

    def _command_display(self) -> str:
        if self.command is None:
            return "<custom check>"
        if isinstance(self.command, str):
            return self.command
        return " ".join(self.command)

    def check(self) -> CheckResult:
        if self.check_fn is not None:
            return self.check_fn()

        if self.command is None:
            raise ValueError(f"Prerequisite '{self.name}' must define a command or check_fn.")

        message: list[str] = []
        try:
            cmd_output = tmux._shell(self.command)
            if self._check_cmd_output(cmd_output):
                return CheckResult(True, "")
            message.append(f"Failed to check: {self.name}")
            message.append(tmux._format_error(self._command_display(), cmd_output))
        except FileNotFoundError:
            message.append(f"Failed to check: {self.name}")
            name = tmux._parse_cmd_name(self.command)
            message.append(
                f"Could not find program `{name}` on the system path "
                f"when running command: {self._command_display()}"
            )

        message.append(self.instructions)

        return CheckResult(False, "\n".join(message))


@dataclass
class WelcomeScreen:
    title: str
    web_urls: list[tuple[str, str]]
    additional_instructions: str

    def render_text(self) -> str:
        parts: list[str] = []
        logo = r"""
         _                                      _
        | |_ _ __ __ _  ___ ___ _ __ ___   ___ | |_
        | __| '__/ _` |/ __/ _ \ '__/ _ \ / _ \| __|
        | |_| | | (_| | (_|  __/ | | (_) | (_) | |_
         \__|_|  \__,_|\___\___|_|  \___/ \___/ \__|
    """
        parts.append(f"\033[1;32m{logo}\033[0m")

        parts.append(f"""
Welcome to the Traceroot {self.title}.

    * To quit, press Ctrl-Q
    * To switch windows, press Shift+Left or Shift+Right
    * To scroll up/down, press Ctrl-B then [. Scroll with Ctrl-U / Ctrl-D.
      Exit scroll mode with Q.
    * Mouse support is enabled: scroll with trackpad, click window names
      in the status bar to switch.
""")

        if self.web_urls:
            url_parts: list[str] = ["Services running:\n"]
            max_len = max(len(name) for name, _ in self.web_urls)
            for name, url in self.web_urls:
                space = " " * (max(max_len - len(name), 0))
                url_parts.append(f"    {name}:{space} \033[4m{url}\033[0m")
            parts.append("\n".join(url_parts) + "\n")

        if self.additional_instructions:
            parts.append(self.additional_instructions)

        return "".join(parts)


@dataclass
class Service:
    title: str
    command: str
    web_urls: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Driver:
    name: str
    services: list[Service]
    welcome_title: str = "development environment"
    additional_instructions: str = ""
    prerequisites: list[Prerequisite] = field(default_factory=list)
    on_exit: str | None = None
    on_start: Callable[[], None] | None = None

    def run(self, detached: bool = False) -> None:
        sess_config = self.build_session_config()
        sess = tmux.TmuxSession(sess_config)
        if not sess.verify_installation():
            exit(1)
        if sess.reattach_existing():
            return

        # Check prerequisites (tools we can't auto-install)
        with ThreadPoolExecutor(max_workers=20) as executor:
            tasks = [executor.submit(dep.check) for dep in self.prerequisites]
            for dep, task in zip(self.prerequisites, tasks):
                print("Checking prerequisite:", dep.name)
                result = task.result()
                if not result.succeeded:
                    print(result.message)
                    exit(1)

        # Run setup (install deps, start infra, migrations)
        if self.on_start:
            self.on_start()

        layout = self.build_layout()
        sess.launch(layout)
        if not detached:
            sess.attach()

    def build_session_config(self) -> tmux.SessionConfig:
        config_file = os.path.join(os.path.dirname(__file__), "default.conf")
        return tmux.SessionConfig(
            session_name=self.name,
            server_name="development",
            config_file=config_file,
        )

    def build_layout(self) -> tmux.SessionLayout:
        # Welcome screen (window 1)
        welcome_text = self.build_welcome().render_text()
        welcome = tmux.Window(
            name="Instructions",
            command=f"printf '%s\n' {quote(welcome_text)}; tail -f /dev/null",
        )

        # Service windows
        windows: list[tmux.Window] = []
        for svc in self.services:
            windows.append(tmux.Window(name=svc.title, command=svc.command))

        return tmux.SessionLayout(
            welcome=welcome,
            windows=windows,
            on_exit=self.on_exit,
        )

    def build_welcome(self) -> WelcomeScreen:
        web_urls: list[tuple[str, str]] = []
        for svc in self.services:
            web_urls.extend(svc.web_urls)

        return WelcomeScreen(
            title=self.welcome_title,
            web_urls=web_urls,
            additional_instructions=self.additional_instructions,
        )
