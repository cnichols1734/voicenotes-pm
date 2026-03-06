"""
VoiceNotes PM - Flask application factory.
Main entry point: creates and configures the Flask app, registers blueprints.
"""
import logging
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


def create_app():
    """Create and configure the Flask application."""
    from flask import Flask
    from flask_cors import CORS
    from flask_login import LoginManager

    from config import Config

    app = Flask(__name__)
    app.config.from_object(Config)

    # Trust Railway's reverse proxy headers so redirects use https://
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    CORS(app)

    # ---- Flask-Login setup ----
    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = "auth.login_page"
    login_manager.login_message = None  # suppress default flash

    @login_manager.user_loader
    def load_user(user_id):
        from services.auth_service import get_user_by_id
        user = get_user_by_id(user_id)
        if user and not user.is_active:
            return None  # disabled accounts cannot load
        return user

    # ---- Register blueprints ----
    from routes.auth import auth_bp
    from routes.main import main_bp
    from routes.recordings import recordings_bp
    from routes.folders import folders_bp
    from routes.meeting_types import meeting_types_bp
    from routes.api import api_bp
    from routes.admin import admin_bp
    from routes.chat import chat_bp
    from routes.mobile import mobile_bp
    from routes.mobile_auth import mobile_auth_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(main_bp)
    app.register_blueprint(recordings_bp)
    app.register_blueprint(folders_bp)
    app.register_blueprint(meeting_types_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(mobile_bp)
    app.register_blueprint(mobile_auth_bp)

    return app


app = create_app()


if __name__ == "__main__":
    import socket
    # Get local IP so user knows what to open on their phone
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)
    port = 5050
    print(f"\n  VoiceNotes PM running!")
    print(f"  Local:   http://localhost:{port}")
    print(f"  Network: http://{local_ip}:{port}  (open this on your phone)\n")
    app.run(host="0.0.0.0", port=port, debug=True)
