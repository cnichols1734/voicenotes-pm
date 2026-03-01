"""
VoiceNotes PM - Flask application factory.
Main entry point: creates and configures the Flask app, registers blueprints.
"""
from dotenv import load_dotenv


load_dotenv()


def create_app():
    """Create and configure the Flask application."""
    from flask import Flask
    from flask_cors import CORS

    from config import Config

    app = Flask(__name__)
    app.config.from_object(Config)

    CORS(app)

    from routes.main import main_bp
    from routes.recordings import recordings_bp
    from routes.folders import folders_bp
    from routes.meeting_types import meeting_types_bp
    from routes.api import api_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(recordings_bp)
    app.register_blueprint(folders_bp)
    app.register_blueprint(meeting_types_bp)
    app.register_blueprint(api_bp)

    return app


app = create_app()
