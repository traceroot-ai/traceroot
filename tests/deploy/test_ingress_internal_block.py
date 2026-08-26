"""Deploy-artifact guard: the service-to-service API stays off the load balancer.

/api/v1/internal/* is reached in-cluster over BACKEND_INTERNAL_URL, so it has no
reason to be routable from outside. The chart drops it with an ALB fixed
response, which depends on two pairings that are easy to break silently:

* the path must be listed *before* /api/v1, so the longer prefix wins;
* the backend service name must equal the ``actions.*`` annotation suffix and
  the port name must be ``use-annotation``, or the controller looks for a real
  Service called "block-internal" and the rule quietly fails to sync.

Neither mistake shows up until traffic is live, and CI has no Helm, so the
structural checks below run unconditionally against the template source and the
full render runs whenever Helm happens to be installed.
"""

import json
import os
import shutil
import subprocess

import pytest
import yaml

_ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_CHART = os.path.join(_ROOT, "deploy", "helm")
_TEMPLATE = os.path.join(_CHART, "templates", "ingress.yaml")
_VALUES = os.path.join(_CHART, "values.yaml")


def _template_text() -> str:
    with open(_TEMPLATE) as f:
        return f.read()


def _values() -> dict:
    with open(_VALUES) as f:
        return yaml.safe_load(f)


def test_blocking_is_on_by_default():
    ingress = _values()["ingress"]
    assert ingress["blockInternalRoutes"] is True
    assert ingress["internalRoutePrefix"] == "/api/v1/internal"


def test_internal_prefix_is_longer_than_the_public_one():
    """A prefix that does not extend /api/v1 would block real API traffic."""
    prefix = _values()["ingress"]["internalRoutePrefix"]
    assert prefix.startswith("/api/v1/") and len(prefix) > len("/api/v1")


def test_internal_path_precedes_the_public_api_path():
    text = _template_text()
    assert text.index("internalRoutePrefix") < text.index("- path: /api/v1\n")


def test_action_name_matches_the_annotation_suffix():
    """`actions.<name>` and the backend service name have to be the same word."""
    text = _template_text()
    assert "alb.ingress.kubernetes.io/actions.block-internal:" in text
    assert "name: block-internal" in text
    assert "name: use-annotation" in text


def test_rule_is_removable_without_an_image_rebuild():
    """Rollback lever: the whole thing hangs off one value."""
    text = _template_text()
    assert text.count("{{- if .Values.ingress.blockInternalRoutes }}") == 2


@pytest.mark.skipif(shutil.which("helm") is None, reason="helm not installed")
class TestRendered:
    @staticmethod
    def _render(*extra: str) -> dict:
        out = subprocess.run(
            ["helm", "template", "traceroot", _CHART, "--set", "ingress.host=example.com", *extra],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        for doc in yaml.safe_load_all(out):
            if doc and doc.get("kind") == "Ingress":
                return doc
        raise AssertionError("chart rendered no Ingress")

    def test_paths_are_ordered_most_specific_first(self):
        paths = [p["path"] for p in self._render()["spec"]["rules"][0]["http"]["paths"]]
        assert paths == ["/api/v1/internal", "/api/v1", "/"]

    def test_action_is_valid_json_the_controller_can_read(self):
        annotations = self._render()["metadata"]["annotations"]
        action = json.loads(annotations["alb.ingress.kubernetes.io/actions.block-internal"])
        assert action["type"] == "fixed-response"
        assert action["fixedResponseConfig"]["statusCode"] == "404"
        assert json.loads(action["fixedResponseConfig"]["messageBody"]) == {"detail": "Not Found"}

    def test_404_not_403_so_the_response_reveals_nothing(self):
        annotations = self._render()["metadata"]["annotations"]
        action = json.loads(annotations["alb.ingress.kubernetes.io/actions.block-internal"])
        assert action["fixedResponseConfig"]["statusCode"] != "403"

    def test_disabling_restores_the_previous_ingress(self):
        doc = self._render("--set", "ingress.blockInternalRoutes=false")
        paths = [p["path"] for p in doc["spec"]["rules"][0]["http"]["paths"]]
        assert paths == ["/api/v1", "/"]
        assert not any("block-internal" in k for k in doc["metadata"]["annotations"])

    def test_internal_callers_bypass_the_load_balancer(self):
        """The premise of the whole change: they use cluster DNS, not the host."""
        out = subprocess.run(
            ["helm", "template", "traceroot", _CHART, "--set", "ingress.host=example.com"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        urls = set()
        for doc in yaml.safe_load_all(out):
            if not doc or doc.get("kind") != "Deployment":
                continue
            for container in doc["spec"]["template"]["spec"]["containers"]:
                for env in container.get("env") or []:
                    if env.get("name") == "BACKEND_INTERNAL_URL":
                        urls.add(env.get("value"))
        assert urls, "no service declares BACKEND_INTERNAL_URL"
        assert urls == {"http://traceroot-rest:8000"}, urls
