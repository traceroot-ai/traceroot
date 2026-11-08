"""Tests for the corpus scoring script."""

from scripts.topic_corpus.score import MIN_ARI, score


def _manifest(labels):
    return {"traces": [{"trace_id": f"t{i}", "label": label} for i, label in enumerate(labels)]}


def _assign(manifest, groups):
    return {t["trace_id"]: g for t, g in zip(manifest["traces"], groups)}


def test_a_perfect_fit_scores_one_and_passes():
    labels = ["a"] * 10 + ["b"] * 10 + ["noise"] * 4
    m = _manifest(labels)
    s = score(m, _assign(m, ["g1"] * 10 + ["g2"] * 10 + [""] * 4))
    assert s.ari == 1.0 and s.worst_topic_recall == 1.0 and not s.mixed_groups
    assert s.unassigned_share == 0.0 and s.noise_unassigned_share == 1.0
    assert s.passes


def test_merging_two_topics_into_one_group_is_flagged_and_fails():
    m = _manifest(["a"] * 10 + ["b"] * 10)
    s = score(m, _assign(m, ["g1"] * 20))
    assert len(s.mixed_groups) == 1 and s.mixed_groups[0]["topics"] == {"a": 0.5, "b": 0.5}
    assert s.ari < MIN_ARI
    assert not s.passes


def test_splitting_a_topic_lowers_its_recall():
    m = _manifest(["a"] * 10 + ["b"] * 10)
    s = score(m, _assign(m, ["g1"] * 5 + ["g3"] * 5 + ["g2"] * 10))
    assert s.topic_recall["a"] == 0.5 and s.topic_recall["b"] == 1.0
    assert not s.passes


def test_traces_left_in_no_group_count_against_the_fit():
    m = _manifest(["a"] * 10 + ["b"] * 10)
    s = score(m, _assign(m, ["g1"] * 10 + [""] * 10))
    assert s.unassigned_share == 0.5 and not s.passes


def test_only_summarized_traces_are_scored():
    m = _manifest(["a"] * 10 + ["b"] * 10)
    partial = {f"t{i}": ("g1" if i < 10 else "g2") for i in range(0, 20, 2)}
    s = score(m, partial)
    assert s.traces_scored == 10


def test_a_minor_contamination_does_not_count_as_mixed():
    m = _manifest(["a"] * 10 + ["b"] * 10)
    groups = ["g1"] * 9 + ["g2"] + ["g2"] * 9 + ["g1"]
    s = score(m, _assign(m, groups))
    assert not s.mixed_groups


def test_assignments_file_is_read_with_empty_group_for_none(tmp_path):
    import json

    from scripts.topic_corpus.score import assignments_from_file

    path = tmp_path / "a.json"
    path.write_text(json.dumps({"assignments": {"t1": "b_1", "t2": None, "t3": ""}}))
    assert assignments_from_file(str(path)) == {"t1": "b_1", "t2": "", "t3": ""}


def test_the_command_scores_an_assignments_file(tmp_path, capsys):
    import json

    from scripts.topic_corpus import score as score_module

    manifest = _manifest(["a"] * 10 + ["b"] * 10)
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    apath = tmp_path / "a.json"
    apath.write_text(json.dumps({"assignments": _assign(manifest, ["g1"] * 10 + ["g2"] * 10)}))
    code = score_module.main(["--manifest", str(mpath), "--assignments", str(apath)])
    assert code == 0
    assert json.loads(capsys.readouterr().out)["passes"] is True


def test_the_command_exits_nonzero_when_the_fit_fails(tmp_path, capsys):
    import json

    from scripts.topic_corpus import score as score_module

    manifest = _manifest(["a"] * 10 + ["b"] * 10)
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    apath = tmp_path / "a.json"
    apath.write_text(json.dumps({"assignments": _assign(manifest, ["g1"] * 20)}))
    assert score_module.main(["--manifest", str(mpath), "--assignments", str(apath)]) == 1
