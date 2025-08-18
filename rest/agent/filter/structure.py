from datetime import datetime

from openai import AsyncOpenAI

from rest.agent.context.tree import LogNode, SpanNode
from rest.agent.output.structure import LogNodeSelectorOutput
from rest.agent.typing import FeatureOps, LogFeature
from rest.typing import NO_TEMPERATURE_MODEL

LOG_NODE_SELECTOR_PROMPT = (
    "You are a helpful assistant that can select related "
    "log nodes based on the user's message.\n"
    "You will be given a user's message and please generate a "
    "list of log features, feature values and feature operations "
    "which will be used to filter the log nodes.\n"
    "Please only include the node features, feature values and feature "
    "operations that are necessary to answer the user's message!\n"
    "Also notice that each log feature corresponds to the feature value "
    "and operation at the same index in the lists.\n"
    "NOTICE: For now you are only allowed to select one log feature!\n"
    "Please be strict and only select the necessary one log feature!"
)


async def log_node_selector(
    user_message: str,
    client: AsyncOpenAI,
    model: str = "gpt-4o-mini",
) -> LogNodeSelectorOutput:
    messages = [
        {
            "role": "system",
            "content": LOG_NODE_SELECTOR_PROMPT
        },
        {
            "role": "user",
            "content": user_message
        },
    ]
    if model in NO_TEMPERATURE_MODEL:
        params = {}
    else:
        params = {
            "temperature": 0.5,
        }
    response = await client.responses.parse(
        model=model,
        input=messages,
        text_format=LogNodeSelectorOutput,
        **params,
    )
    if model in NO_TEMPERATURE_MODEL:
        response: LogNodeSelectorOutput = response.output[1].content[0].parsed
    else:
        response: LogNodeSelectorOutput = response.output[0].content[0].parsed
    return response


def apply_operation(log_value: str, filter_value: str, operation: FeatureOps) -> bool:
    r"""Apply the filtering operation between log value
    and filter value.
    """
    log_value_lower = log_value.lower()
    filter_value_lower = filter_value.lower()

    if operation == FeatureOps.EQUAL:
        return log_value_lower == filter_value_lower
    elif operation == FeatureOps.NOT_EQUAL:
        return log_value_lower != filter_value_lower
    elif operation == FeatureOps.CONTAINS:
        return filter_value_lower in log_value_lower
    elif operation == FeatureOps.NOT_CONTAINS:
        return filter_value_lower not in log_value_lower
    else:
        return False


def get_log_feature_value(
    log: LogNode,
    feature: LogFeature,
    is_github_pr: bool = False,
) -> str | int | datetime:
    r"""Get the feature value from a LogNode."""
    feature_mapping = {
        LogFeature.LOG_UTC_TIMESTAMP: log.log_utc_timestamp,
        LogFeature.LOG_LEVEL: log.log_level,
        LogFeature.LOG_FILE_NAME: log.log_file_name,
        LogFeature.LOG_FUNC_NAME: log.log_func_name,
        LogFeature.LOG_MESSAGE_VALUE: log.log_message,
        LogFeature.LOG_LINE_NUMBER: str(log.log_line_number),
        LogFeature.LOG_SOURCE_CODE_LINE: log.log_source_code_line,
    }
    if is_github_pr:
        feature_mapping[LogFeature.LOG_SOURCE_CODE_LINES_ABOVE
                        ] = "\n".join(log.log_source_code_lines_above)
        feature_mapping[LogFeature.LOG_SOURCE_CODE_LINES_BELOW
                        ] = "\n".join(log.log_source_code_lines_below)
    return feature_mapping.get(feature, "")


def filter_log_node(
    feature_types: list[LogFeature],
    feature_values: list[str],
    feature_ops: list[FeatureOps],
    node: SpanNode,
    is_github_pr: bool = False,
) -> SpanNode:
    r"""Filter the log node based on the log node features.

    Recursively filters logs in the span tree based on the provided criteria.
    All three lists (feature_types, feature_values, feature_ops) must have the
    same length and correspond to each other exactly.

    Args:
        feature_types (list[LogFeature]): List of LogFeature enums specifying
            which features to filter on.
        feature_values (list[str]): List of string values to compare against.
        feature_ops (list[FeatureOps]): List of FeatureOps enums specifying the
            perform.
        node: SpanNode to filter.
        is_github_pr (bool): Whether the current node is a GitHub PR.

    Returns:
        SpanNode: A new filtered SpanNode with only logs and children that
            match the criteria.
    """

    def matches_filters(log: LogNode) -> bool:
        r"""Check if a log matches all filter criteria."""
        for feature_type, feature_value, feature_op in zip(
                feature_types, feature_values, feature_ops):
            log_value = get_log_feature_value(log, feature_type)
            if not apply_operation(str(log_value), str(feature_value), feature_op):
                return False
        return True

    # Validate input parameters
    if len(feature_types) != len(feature_values) or len(feature_types
                                                        ) != len(feature_ops):
        raise ValueError(
            "feature_types, feature_values, and "
            "feature_ops must have the same length"
        )

    # Filter logs in the current node
    filtered_logs = [log for log in node.logs if matches_filters(log)]

    # Recursively filter child nodes
    filtered_children = []
    for child in node.children_spans:
        filtered_child = filter_log_node(
            feature_types,
            feature_values,
            feature_ops,
            child
        )
        # Only include child if it has logs or children after filtering
        if filtered_child.logs or filtered_child.children_spans:
            filtered_children.append(filtered_child)

    # Create a new SpanNode with filtered content
    return SpanNode(
        span_id=node.span_id,
        func_full_name=node.func_full_name,
        span_latency=node.span_latency,
        span_utc_start_time=node.span_utc_start_time,
        span_utc_end_time=node.span_utc_end_time,
        logs=filtered_logs,
        children_spans=filtered_children,
    )
