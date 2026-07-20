from omni_migrator.core.process_limits import apply_bridge_process_limits


def test_process_limits_are_best_effort_without_requested_limits(monkeypatch):
    monkeypatch.delenv("OMNIKIT_ENGINE_MEMORY_MB", raising=False)
    monkeypatch.delenv("OMNIKIT_ENGINE_CPU_SECONDS", raising=False)

    result = apply_bridge_process_limits()

    assert isinstance(result["supported"], bool)
    assert "memory_mb" not in result
    assert "cpu_seconds" not in result


def test_process_limits_do_not_abort_when_the_operating_system_rejects_limits(monkeypatch):
    import resource

    monkeypatch.setenv("OMNIKIT_ENGINE_MEMORY_MB", "512")
    monkeypatch.setenv("OMNIKIT_ENGINE_CPU_SECONDS", "30")
    monkeypatch.setattr(
        resource,
        "setrlimit",
        lambda *_args: (_ for _ in ()).throw(ValueError("unsupported")),
    )

    result = apply_bridge_process_limits()

    assert result["supported"] is True
    assert result["memory_limit_applied"] is False
    assert result["cpu_limit_applied"] is False
