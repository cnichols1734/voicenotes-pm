"""
VoiceNotes PM - Page routes.
Renders server-side HTML templates for each page.
"""
from flask import Blueprint, render_template
from flask_login import login_required, current_user

main_bp = Blueprint("main", __name__, url_prefix="/")


@main_bp.route("/")
@login_required
def index():
    """Render the main dashboard with meeting list and folders sidebar."""
    return render_template("dashboard.html")


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
