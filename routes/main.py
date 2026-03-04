"""
VoiceNotez - Page routes.
Renders server-side HTML templates for each page.
"""
from flask import Blueprint, render_template, send_from_directory
from flask_login import login_required, current_user

main_bp = Blueprint("main", __name__, url_prefix="/")


@main_bp.route("/")
def index():
    """Landing page for visitors, dashboard for authenticated users."""
    if current_user.is_authenticated:
        return render_template("dashboard.html")
    return render_template("landing.html")


@main_bp.route("/meeting/<meeting_id>")
@login_required
def meeting_detail(meeting_id):
    """Render single meeting detail view (transcript + summary)."""
    return render_template("recording.html", meeting_id=meeting_id)


@main_bp.route("/meeting-types")
@login_required
def meeting_types_page():
    """Render the meeting type prompt editor page."""
    return render_template("meeting_types.html")
