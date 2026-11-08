"""Group ids carry over between fits through shared traces."""

from worker.task_groups.identity import match_groups


def ids(prefix, start, stop):
    return {f"{prefix}{i}" for i in range(start, stop)}


def test_a_cluster_with_the_same_members_keeps_its_group_id():
    old = {"g1": ids("t", 0, 30), "g2": ids("t", 30, 60)}
    new = {0: ids("t", 0, 30) | ids("n", 0, 4), 1: ids("t", 30, 60)}
    result = match_groups(old, new, known_before=ids("t", 0, 60))
    assert result == {0: "g1", 1: "g2"}


def test_labels_may_be_permuted_between_fits():
    old = {"g1": ids("t", 0, 30), "g2": ids("t", 30, 60)}
    new = {5: ids("t", 30, 60), 2: ids("t", 0, 30)}
    assert match_groups(old, new, ids("t", 0, 60)) == {5: "g2", 2: "g1"}


def test_a_new_cluster_with_no_overlap_gets_no_old_id():
    old = {"g1": ids("t", 0, 30)}
    new = {0: ids("t", 0, 30), 1: ids("x", 0, 30)}
    assert match_groups(old, new, ids("t", 0, 30)) == {0: "g1", 1: None}


def test_when_a_group_splits_the_larger_part_keeps_the_id():
    old = {"g1": ids("t", 0, 60)}
    new = {0: ids("t", 0, 40), 1: ids("t", 40, 60)}
    assert match_groups(old, new, ids("t", 0, 60)) == {0: "g1", 1: None}


def test_when_groups_merge_the_larger_old_group_keeps_its_id_and_one_id_is_used_once():
    old = {"g1": ids("t", 0, 40), "g2": ids("t", 40, 60)}
    new = {0: ids("t", 0, 60)}
    result = match_groups(old, new, ids("t", 0, 60))
    assert result == {0: "g1"}


def test_a_few_shared_traces_are_not_a_match():
    old = {"g1": ids("t", 0, 30)}
    new = {0: ids("t", 0, 2) | ids("x", 0, 40)}
    assert match_groups(old, new, ids("t", 0, 30)) == {0: None}


def test_traces_that_arrived_after_the_last_fit_do_not_dilute_a_match():
    old = {"g1": ids("t", 0, 20)}
    # 20 old members plus 100 new traces: judged on the 20 that existed before.
    new = {0: ids("t", 0, 20) | ids("n", 0, 100)}
    assert match_groups(old, new, ids("t", 0, 20)) == {0: "g1"}


def test_the_result_does_not_depend_on_dict_order():
    old = {"g2": ids("t", 30, 60), "g1": ids("t", 0, 30)}
    new = {1: ids("t", 30, 60), 0: ids("t", 0, 30)}
    assert match_groups(old, new, ids("t", 0, 60)) == match_groups(
        dict(reversed(list(old.items()))), dict(reversed(list(new.items()))), ids("t", 0, 60)
    )
