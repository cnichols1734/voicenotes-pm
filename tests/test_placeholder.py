"""
VoiceNotes PM - Basic boot and health check tests.
Run with: pytest tests/
"""
import pytest


def test_app_boots():
    """Verify the Flask app creates without error."""
    from app import create_app
    application = create_app()
    assert application is not None


def test_health_endpoint():
    """Verify health check returns 200 with correct payload."""
    from app import create_app
    application = create_app()
    client = application.test_client()
    response = client.get('/api/health')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'ok'
    assert 'version' in data


def test_index_returns_html():
    """Verify dashboard page renders and contains app name."""
    from app import create_app
    application = create_app()
    client = application.test_client()
    response = client.get('/')
    assert response.status_code == 200
    assert b'VoiceNotes PM' in response.data


def test_meeting_types_page():
    """Verify meeting types page renders."""
    from app import create_app
    application = create_app()
    client = application.test_client()
    response = client.get('/meeting-types')
    assert response.status_code == 200


def test_settings_endpoint():
    """Verify settings returns non-sensitive config."""
    from app import create_app
    application = create_app()
    client = application.test_client()
    response = client.get('/api/settings')
    assert response.status_code == 200
    data = response.get_json()
    assert 'openrouter_model' in data
