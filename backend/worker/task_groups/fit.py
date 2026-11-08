"""The periodic fit: reduce summary embeddings, find dense regions, and describe
each region by where it sits and how far its members reach.

Pure numerics, no I/O. Input vectors are the embeddings of one project's
summaries over the fit window; the output says, for every row, which cluster it
belongs to (or none), and for every cluster its center, reach and size.

Center and reach are measured in the original embedding space (cosine), not in
the reduced space, because that is the space the per-trace placement step
(nearest center within reach) works in later.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Below this many summaries no groups are produced: a handful of points cannot
# show structure, and a wrong map is worse than none.
MIN_DIGESTS = 100


@dataclass(frozen=True)
class FitParams:
    # Dimensions kept by UMAP for clustering (not for display).
    umap_components: int = 10
    umap_neighbors: int = 30
    umap_min_dist: float = 0.0
    # A cluster needs at least this share of the rows, within a floor and a cap.
    min_cluster_share: float = 0.06
    min_cluster_floor: int = 10
    min_cluster_cap: int = 300
    min_samples: int = 5
    # "eom" keeps the largest stable clusters; "leaf" splits down to the finest stable ones.
    selection: str = "eom"
    # Share of a cluster's members that must lie inside its reach.
    reach_quantile: float = 0.95
    # Reach is that quantile times this margin: a member's neighbours that the density
    # step left out (a variant of the task with too few examples to form its own
    # cluster) still lie inside, and new traces of the same kind are placed alongside.
    reach_margin: float = 1.5
    # No reach is wider than this cosine distance (1.0 is "unrelated"), however loose a
    # cluster of unrelated one-off requests is.
    reach_cap: float = 0.7
    # Dimensions the vectors are first projected to (PCA) so the neighbour search is cheap.
    pca_components: int = 64
    seed: int = 42


@dataclass
class FitResult:
    # Cluster label per input row, -1 for none. Labels are 0..k-1.
    labels: np.ndarray
    # Cosine distance from each row to its cluster's center (to the nearest center for -1 rows).
    distances: np.ndarray
    centers: np.ndarray  # (k, d), unit length
    reaches: np.ndarray  # (k,)
    sizes: np.ndarray  # (k,)


def normalize(vectors: np.ndarray) -> np.ndarray:
    """Unit-length rows as float32; a zero row stays zero."""
    v = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return v / norms


def min_cluster_size(n: int, params: FitParams) -> int:
    return max(
        params.min_cluster_floor, min(params.min_cluster_cap, round(params.min_cluster_share * n))
    )


def _reduce(x: np.ndarray, params: FitParams) -> np.ndarray:
    import umap  # imported late: numba compiles on first use, only a fit pays for it
    from sklearn.decomposition import PCA

    n, d = x.shape
    if d > params.pca_components and n > params.pca_components:
        x = PCA(n_components=params.pca_components, random_state=params.seed).fit_transform(x)
        x = normalize(x)
    return umap.UMAP(
        n_components=min(params.umap_components, max(2, n - 2)),
        n_neighbors=min(params.umap_neighbors, n - 1),
        min_dist=params.umap_min_dist,
        metric="cosine",
        random_state=params.seed,
        low_memory=True,
    ).fit_transform(x)


def fit_groups(vectors: np.ndarray, params: FitParams = FitParams()) -> FitResult | None:
    """Fit groups to ``vectors``. Returns None below ``MIN_DIGESTS`` rows.

    Rows are expected in a fixed order (the caller sorts by trace id); the same
    rows in the same order and the same parameters give the same result.
    """
    from sklearn.cluster import HDBSCAN

    x = normalize(vectors)
    n = len(x)
    if n < MIN_DIGESTS:
        return None

    reduced = _reduce(x, params)
    labels = HDBSCAN(
        min_cluster_size=min_cluster_size(n, params),
        min_samples=params.min_samples,
        cluster_selection_method=params.selection,
        copy=True,
    ).fit_predict(reduced)

    k = int(labels.max()) + 1 if (labels >= 0).any() else 0
    if k == 0:
        return FitResult(
            labels=labels,
            distances=np.ones(n, dtype=np.float32),
            centers=np.zeros((0, x.shape[1]), dtype=np.float32),
            reaches=np.zeros(0, dtype=np.float32),
            sizes=np.zeros(0, dtype=np.int64),
        )

    centers = normalize(np.stack([x[labels == c].mean(axis=0) for c in range(k)]))
    distances = 1.0 - x @ centers.T  # (n, k)
    own = np.where(
        labels >= 0, distances[np.arange(n), np.maximum(labels, 0)], distances.min(axis=1)
    )
    reaches = np.array(
        [
            min(
                params.reach_cap,
                params.reach_margin * np.quantile(own[labels == c], params.reach_quantile),
            )
            for c in range(k)
        ],
        dtype=np.float32,
    )

    # A row HDBSCAN left out that still lies inside the reach of its nearest center
    # is placed there: the same rule the per-trace placement uses.
    nearest = distances.argmin(axis=1)
    for i in np.flatnonzero(labels == -1):
        c = nearest[i]
        if distances[i, c] <= reaches[c]:
            labels[i] = c
    sizes = np.bincount(labels[labels >= 0], minlength=k).astype(np.int64)
    return FitResult(
        labels=labels,
        distances=np.where(labels >= 0, distances[np.arange(n), np.maximum(labels, 0)], own).astype(
            np.float32
        ),
        centers=centers.astype(np.float32),
        reaches=reaches,
        sizes=sizes,
    )


def exemplar_indices(vectors: np.ndarray, result: FitResult, label: int, count: int) -> list[int]:
    """Row indices of the members nearest their cluster's center, nearest first."""
    members = np.flatnonzero(result.labels == label)
    order = np.argsort(result.distances[members], kind="stable")
    return [int(i) for i in members[order][:count]]


def spread_indices(vectors: np.ndarray, result: FitResult, label: int, count: int) -> list[int]:
    """Members chosen to show the range of a cluster: the one nearest the center, then
    repeatedly the member farthest from those already chosen (among members inside the
    cluster's reach, so a stray outlier is not what represents it)."""
    x = normalize(vectors)
    members = np.flatnonzero(result.labels == label)
    inside = members[result.distances[members] <= result.reaches[label]]
    pool = inside if len(inside) >= count else members
    chosen = [int(pool[np.argmin(result.distances[pool])])]
    nearest = 1.0 - x[pool] @ x[chosen[0]]
    while len(chosen) < min(count, len(pool)):
        pick = int(pool[np.argmax(nearest)])
        chosen.append(pick)
        nearest = np.minimum(nearest, 1.0 - x[pool] @ x[pick])
    return chosen
