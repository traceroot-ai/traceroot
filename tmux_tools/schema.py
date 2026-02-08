"""Declarative schema for defining development configurations."""

import os
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from shlex import quote
from subprocess import CompletedProcess
from typing import Callable, List, Optional, Tuple

from tmux_tools import tmux


@dataclass
class CheckResult:
    succeeded: bool
    message: str


@dataclass
class Prerequisite:
    name: str
    command: str
    instructions: str
    expected_output: Optional[str] = None

    def _check_cmd_output(self, cmd_output: CompletedProcess) -> bool:
        return (cmd_output.returncode == 0 and
                (not self.expected_output
                 or re.search(self.expected_output, cmd_output.stdout))
                is not None)

    def check(self) -> CheckResult:
        message: List[str] = []
        try:
            bash_cmd = f"bash -c {quote(self.command)}"
            cmd_output = tmux._shell(bash_cmd)
            if self._check_cmd_output(cmd_output):
                return CheckResult(True, "")
            message.append(f"Failed to check: {self.name}")
            message.append(tmux._format_error(self.command, cmd_output))
        except FileNotFoundError:
            message.append(f"Failed to check: {self.name}")
            name = tmux._parse_cmd_name(self.command)
            message.append(
                f"Could not find program `{name}` on the system path "
                f"when running command: {self.command}")

        message.append(self.instructions)

        return CheckResult(False, '\n'.join(message))


@dataclass
class WelcomeScreen:
    web_urls: List[Tuple[str, str]]
    additional_instructions: str

    def render_text(self) -> str:
        parts: List[str] = []
        logo = r"""
         _                                    _
        | |_ _ __ __ _  ___ ___ _ __ ___   ___ | |_
        | __| '__/ _` |/ __/ _ \ '__/ _ \ / _ \| __|
        | |_| | | (_| | (_|  __/ | | (_) | (_) | |_
         \__|_|  \__,_|\___\___|_|  \___/ \___/ \__|
    """
        parts.append(f"\033[1;32m{logo}\033[0m")

        parts.append("""
Welcome to the Traceroot development environment.

    * To quit, press Ctrl-Q
    * To switch windows, press Shift+Left or Shift+Right
    * To scroll up/down, press Ctrl-B then [. Scroll with Ctrl-U / Ctrl-D.
      Exit scroll mode with Q.
    * Mouse support is enabled: scroll with trackpad, click window names
      in the status bar to switch.
""")

        if self.web_urls:
            url_parts: List[str] = [
                "Services running:\n"
            ]
            max_len = max(len(name) for name, _ in self.web_urls)
            for name, url in self.web_urls:
                space = " " * (max(max_len - len(name), 0))
                url_parts.append(f"    {name}:{space} \033[4m{url}\033[0m")
            parts.append('\n'.join(url_parts) + '\n')

        if self.additional_instructions:
            parts.append(self.additional_instructions)

        return ''.join(parts)


@dataclass
class Service:
    title: str
    command: str
    web_urls: List[Tuple[str, str]] = field(default_factory=list)


@dataclass
class Driver:
    name: str
    services: List[Service]
    additional_instructions: str = ""
    prerequisites: List[Prerequisite] = field(default_factory=list)
    on_exit: Optional[str] = None
    on_start: Optional[Callable[[], None]] = None

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
        config_file = os.path.join(os.path.dirname(__file__), 'default.conf')
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
            command=f'echo {quote(welcome_text)}',
        )

        # Service windows
        windows: List[tmux.Window] = []
        for svc in self.services:
            windows.append(
                tmux.Window(name=svc.title, command=svc.command))

        return tmux.SessionLayout(
            welcome=welcome,
            windows=windows,
            on_exit=self.on_exit,
        )

    def build_welcome(self) -> WelcomeScreen:
        web_urls: List[Tuple[str, str]] = []
        for svc in self.services:
            web_urls.extend(svc.web_urls)

        return WelcomeScreen(
            web_urls=web_urls,
            additional_instructions=self.additional_instructions,
        )
