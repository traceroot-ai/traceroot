"""The numeric fit on synthetic embeddings (no model calls)."""

import numpy as np
import pytest

from worker.task_groups.fit import (
    MIN_DIGESTS,
    exemplar_indices,
    fit_groups,
    spread_indices,
)


def blobs(per=60, k=4, dim=64, noise=0.35, seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(k, dim))
    x = np.concatenate([centers[i] + noise * rng.normal(size=(per, dim)) for i in range(k)])
    truth = np.repeat(np.arange(k), per)
    return x.astype(np.float32), truth


@pytest.fixture(scope="module")
def fitted():
    x, truth = blobs()
    return x, truth, fit_groups(x)


def test_below_the_gate_no_groups_are_produced():
    x, _ = blobs(per=MIN_DIGESTS // 4 - 1)
    assert len(x) < MIN_DIGESTS
    assert fit_groups(x) is None


def test_finds_the_planted_clusters(fitted):
    _x, truth, result = fitted
    assert result.centers.shape[0] == 4
    # Each blob maps to exactly one cluster, each cluster to one blob.
    for blob in range(4):
        labels = result.labels[truth == blob]
        assert (labels == np.bincount(labels[labels >= 0]).argmax()).mean() > 0.95


def test_centers_are_unit_length_and_sizes_add_up(fitted):
    _x, _, result = fitted
    assert np.allclose(np.linalg.norm(result.centers, axis=1), 1.0, atol=1e-4)
    assert result.sizes.sum() == (result.labels >= 0).sum()


def test_most_members_lie_inside_their_clusters_reach(fitted):
    _, _, result = fitted
    for c in range(len(result.reaches)):
        inside = result.distances[result.labels == c] <= result.reaches[c] + 1e-6
        assert inside.mean() >= 0.94


def test_the_same_input_gives_the_same_labels():
    x, _ = blobs(per=40, seed=3)
    a, b = fit_groups(x), fit_groups(x)
    assert np.array_equal(a.labels, b.labels)


def test_exemplars_are_the_members_nearest_the_center(fitted):
    x, _, result = fitted
    picked = exemplar_indices(x, result, 0, 5)
    assert len(picked) == 5 and all(result.labels[i] == 0 for i in picked)
    assert result.distances[picked].tolist() == sorted(result.distances[picked].tolist())


def test_spread_picks_distinct_members_that_cover_the_cluster(fitted):
    x, _, result = fitted
    picked = spread_indices(x, result, 1, 6)
    assert len(set(picked)) == 6 and all(result.labels[i] == 1 for i in picked)
    # The first is the member nearest the center.
    assert picked[0] == exemplar_indices(x, result, 1, 1)[0]


def test_no_reach_exceeds_the_cap(fitted):
    from worker.task_groups.fit import FitParams

    _x, _, result = fitted
    assert (result.reaches <= FitParams().reach_cap + 1e-6).all()
