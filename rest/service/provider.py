from rest.service.log.log_client import LogClient
from rest.service.trace.trace_client import TraceClient

try:
    from rest.service.log.ee.aws_log_client import AWSLogClient
    from rest.service.trace.ee.aws_trace_client import AWSTraceClient
except ImportError:
    from rest.service.log.aws_log_client import AWSLogClient
    from rest.service.trace.aws_trace_client import AWSTraceClient

try:
    from rest.service.log.ee.tencent_log_client import TencentLogClient
    from rest.service.trace.ee.tencent_trace_client import TencentTraceClient
except ImportError:
    from rest.service.log.tencent_log_client import TencentLogClient
    from rest.service.trace.tencent_trace_client import TencentTraceClient

from rest.service.log.jaeger_log_client import JaegerLogClient
from rest.service.trace.jaeger_trace_client import JaegerTraceClient


class ObservabilityProvider:
    """Unified provider that composes log and trace clients.

    This class provides a single interface to access both log and trace
    operations from different observability backends.
    """

    def __init__(
        self,
        log_client: LogClient,
        trace_client: TraceClient,
    ):
        """Initialize the observability provider.

        Args:
            log_client: Log client implementation
            trace_client: Trace client implementation
        """
        self.log_client = log_client
        self.trace_client = trace_client

    @classmethod
    def create_aws_provider(
        cls,
        aws_region: str | None = None,
    ) -> "ObservabilityProvider":
        """Create an AWS-based observability provider.

        Args:
            aws_region: AWS region to use

        Returns:
            ObservabilityProvider configured for AWS
        """
        log_client = AWSLogClient(aws_region=aws_region)
        trace_client = AWSTraceClient(aws_region=aws_region)
        return cls(log_client=log_client, trace_client=trace_client)

    @classmethod
    def create_tencent_provider(
        cls,
        tencent_region: str | None = None,
    ) -> "ObservabilityProvider":
        """Create a Tencent-based observability provider.

        Args:
            tencent_region: Tencent region to use

        Returns:
            ObservabilityProvider configured for Tencent
        """
        log_client = TencentLogClient(tencent_region=tencent_region)
        trace_client = TencentTraceClient(tencent_region=tencent_region)
        return cls(log_client=log_client, trace_client=trace_client)

    @classmethod
    def create_jaeger_provider(
        cls,
        jaeger_url: str | None = None,
    ) -> "ObservabilityProvider":
        """Create a Jaeger-based observability provider.

        Args:
            jaeger_url: Jaeger URL to use

        Returns:
            ObservabilityProvider configured for Jaeger
        """
        # Jaeger clients share the same URL
        log_client = JaegerLogClient(jaeger_url=jaeger_url)
        trace_client = JaegerTraceClient(jaeger_url=jaeger_url)
        return cls(log_client=log_client, trace_client=trace_client)
