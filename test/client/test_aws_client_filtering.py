import json
from unittest.mock import AsyncMock, patch

import pytest

# Try to import the AWS client, skip tests if not available
try:
    from rest.client.ee.aws_client import TraceRootAWSClient
    aws_client_available = True
except ImportError:
    aws_client_available = False
    TraceRootAWSClient = None

# Skip all tests in this module if AWS client is not available
pytestmark = pytest.mark.skipif(
    not aws_client_available,
    reason="rest.client.ee.aws_client not available"
)


@pytest.mark.asyncio
async def test_get_trace_with_spans_by_ids_filtering():
    """Test filtering functionality in get_trace_with_spans_by_ids"""

    # Mock AWS client
    client = TraceRootAWSClient(aws_region="us-west-2")

    # Mock trace data with different metadata
    mock_trace_data = {
        'Traces': [
            {
                'Segments': [
                    {
                        'Document':
                        json.dumps(
                            {
                                'trace_id': 'trace-123',
                                'id': 'span-1',
                                'name': 'test-span-1',
                                'start_time': 1000.0,
                                'end_time': 2000.0,
                                'metadata': {
                                    'default': {
                                        'log.metadata.requestId': '123',
                                        'log.metadata.userId': '456'
                                    }
                                }
                            }
                        )
                    },
                    {
                        'Document':
                        json.dumps(
                            {
                                'trace_id': 'trace-456',
                                'id': 'span-2',
                                'name': 'test-span-2',
                                'start_time': 1000.0,
                                'end_time': 2000.0,
                                'metadata': {
                                    'default': {
                                        'log.metadata.requestId': '789',
                                        'log.metadata.userId': '999'
                                    }
                                }
                            }
                        )
                    }
                ]
            }
        ]
    }

    # Mock the _batch_get_traces method
    with patch.object(client, '_batch_get_traces', new_callable=AsyncMock) as mock_batch:
        mock_batch.return_value = mock_trace_data

        # Test 1: No filtering (should return both traces)
        result = await client.get_trace_with_spans_by_ids(['trace-123', 'trace-456'])
        assert len(result) == 2
        assert 'trace-123' in result
        assert 'trace-456' in result

        # Test 2: Filter by requestId=123 (should return only trace-123)
        result = await client.get_trace_with_spans_by_ids(
            ['trace-123',
             'trace-456'],
            categories=['requestId'],
            values=['123']
        )
        assert len(result) == 1
        assert 'trace-123' in result
        assert 'trace-456' not in result

        # Test 3: Filter by requestId=789 (should return only trace-456)
        result = await client.get_trace_with_spans_by_ids(
            ['trace-123',
             'trace-456'],
            categories=['requestId'],
            values=['789']
        )
        assert len(result) == 1
        assert 'trace-456' in result
        assert 'trace-123' not in result

        # Test 4: Filter by non-existent value (should return empty)
        result = await client.get_trace_with_spans_by_ids(
            ['trace-123',
             'trace-456'],
            categories=['requestId'],
            values=['nonexistent']
        )
        assert len(result) == 0

        # Test 5: Filter by multiple categories/values
        result = await client.get_trace_with_spans_by_ids(
            ['trace-123',
             'trace-456'],
            categories=['requestId',
                        'userId'],
            values=['123',
                    '456']
        )
        assert len(result) == 1
        assert 'trace-123' in result


@pytest.mark.asyncio
async def test_get_trace_with_spans_by_ids_filtering_with_subsegments():
    """Test filtering with nested subsegments"""

    client = TraceRootAWSClient(aws_region="us-west-2")

    # Mock trace data with subsegments
    mock_trace_data = {
        'Traces': [
            {
                'Segments': [
                    {
                        'Document':
                        json.dumps(
                            {
                                'trace_id':
                                'trace-with-subsegments',
                                'id':
                                'root-span',
                                'name':
                                'root-span',
                                'start_time':
                                1000.0,
                                'end_time':
                                3000.0,
                                'metadata': {
                                    'default': {
                                        'log.metadata.service': 'api'
                                    }
                                },
                                'subsegments': [
                                    {
                                        'id': 'child-span-1',
                                        'name': 'child-span-1',
                                        'start_time': 1200.0,
                                        'end_time': 1800.0,
                                        'metadata': {
                                            'default': {
                                                'log.metadata.requestId': '123'
                                            }
                                        }
                                    },
                                    {
                                        'id': 'child-span-2',
                                        'name': 'child-span-2',
                                        'start_time': 1900.0,
                                        'end_time': 2500.0,
                                        'metadata': {
                                            'default': {
                                                'log.metadata.requestId': '456'
                                            }
                                        }
                                    }
                                ]
                            }
                        )
                    }
                ]
            }
        ]
    }

    with patch.object(client, '_batch_get_traces', new_callable=AsyncMock) as mock_batch:
        mock_batch.return_value = mock_trace_data

        # Test filtering by child span metadata (should include trace)
        result = await client.get_trace_with_spans_by_ids(
            ['trace-with-subsegments'],
            categories=['requestId'],
            values=['123']
        )
        assert len(result) == 1
        assert 'trace-with-subsegments' in result

        # Test filtering by non-existent child metadata (should exclude trace)
        result = await client.get_trace_with_spans_by_ids(
            ['trace-with-subsegments'],
            categories=['requestId'],
            values=['nonexistent']
        )
        assert len(result) == 0


if __name__ == "__main__":
    pytest.main([__file__])
