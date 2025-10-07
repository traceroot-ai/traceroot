from typing import Any

from rest.service.log.log_client import LogClient
from rest.service.trace.trace_client import TraceClient
from rest.typing import ObservabilityProviderType

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


class ProviderFactory:
    """Factory for creating log and trace client instances on-the-fly.

    Creates fresh client instances for each request, supporting dynamic
    provider selection (e.g., per-request Tencent logs with default AWS traces).
    """

    @staticmethod
    def create_log_client(
        provider: ObservabilityProviderType | str,
        **kwargs: Any
    ) -> LogClient:
        """Create a fresh log client instance for the specified provider.

        Args:
            provider: Provider type (enum or string like 'aws', 'tencent', 'jaeger')
            **kwargs: Provider-specific configuration

        Returns:
            New LogClient instance

        Raises:
            ValueError: If provider is not supported
        """
        provider = ObservabilityProviderType(provider)

        if provider == ObservabilityProviderType.AWS:
            return AWSLogClient(aws_region=kwargs.get('region'))
        elif provider == ObservabilityProviderType.TENCENT:
            return TencentLogClient(tencent_region=kwargs.get('region'))
        elif provider == ObservabilityProviderType.JAEGER:
            return JaegerLogClient(jaeger_url=kwargs.get('url'))
        else:
            raise ValueError(f"Unknown log provider: {provider}")

    @staticmethod
    def create_trace_client(
        provider: ObservabilityProviderType | str,
        **kwargs: Any
    ) -> TraceClient:
        """Create a fresh trace client instance for the specified provider.

        Args:
            provider: Provider type (enum or string like 'aws', 'tencent', 'jaeger')
            **kwargs: Provider-specific configuration

        Returns:
            New TraceClient instance

        Raises:
            ValueError: If provider is not supported
        """
        provider = ObservabilityProviderType(provider)

        if provider == ObservabilityProviderType.AWS:
            return AWSTraceClient(aws_region=kwargs.get('region'))
        elif provider == ObservabilityProviderType.TENCENT:
            return TencentTraceClient(tencent_region=kwargs.get('region'))
        elif provider == ObservabilityProviderType.JAEGER:
            return JaegerTraceClient(jaeger_url=kwargs.get('url'))
        else:
            raise ValueError(f"Unknown trace provider: {provider}")


class ObservabilityProvider:
    """Unified provider that composes log and trace clients.

    Supports dynamic, per-request provider selection. Creates fresh client
    instances for each request, allowing mixed providers
    (e.g., Tencent logs + AWS traces).
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
    def create(
        cls,
        log_provider: ObservabilityProviderType | str = 'aws',
        trace_provider: ObservabilityProviderType | str = 'aws',
        log_config: dict[str,
                         Any] | None = None,
        trace_config: dict[str,
                           Any] | None = None,
    ) -> "ObservabilityProvider":
        """Create an observability provider with fresh client instances.

        Args:
            log_provider: Log provider (enum or string: 'aws', 'tencent', 'jaeger')
            trace_provider: Trace provider (enum or string: 'aws', 'tencent', 'jaeger')
            log_config: Configuration dict for log provider
            trace_config: Configuration dict for trace provider

        Returns:
            ObservabilityProvider instance with fresh client instances

        Examples:
            # Default: AWS for both
            provider = ObservabilityProvider.create()

            # Tencent logs + AWS traces (string)
            provider = ObservabilityProvider.create(
                log_provider='tencent',
                log_config={'region': 'ap-guangzhou'}
            )

            # Tencent logs + AWS traces (enum)
            provider = ObservabilityProvider.create(
                log_provider=ObservabilityProviderType.TENCENT,
                log_config={'region': 'ap-guangzhou'}
            )

            # Jaeger for both (local mode)
            provider = ObservabilityProvider.create(
                log_provider='jaeger',
                trace_provider='jaeger',
                log_config={'url': 'http://localhost:16686'},
                trace_config={'url': 'http://localhost:16686'}
            )
        """
        log_config = log_config or {}
        trace_config = trace_config or {}

        # Create fresh client instances for each request
        log_client = ProviderFactory.create_log_client(log_provider, **log_config)
        trace_client = ProviderFactory.create_trace_client(trace_provider, **trace_config)

        return cls(log_client=log_client, trace_client=trace_client)

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
        return cls.create(
            log_provider='aws',
            trace_provider='aws',
            log_config={'region': aws_region},
            trace_config={'region': aws_region}
        )

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
        return cls.create(
            log_provider='tencent',
            trace_provider='tencent',
            log_config={'region': tencent_region},
            trace_config={'region': tencent_region}
        )

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
        return cls.create(
            log_provider='jaeger',
            trace_provider='jaeger',
            log_config={'url': jaeger_url},
            trace_config={'url': jaeger_url}
        )
