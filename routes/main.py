"""
Main routes - Dashboard and index.
"""
from flask import Blueprint, render_template

main_bp = Blueprint("main", __name__, url_prefix="/")


@main_bp.route("/")
def index():
    """Render the main dashboard with meeting list and folders sidebar."""
    return render_template("dashboard.html")


@main_bp.route("/recordings/<int:recording_id>")
def recording_detail(recording_id):
    """Render single meeting detail view (transcript + summary)."""
    return render_template("recording.html", recording_id=recording_id)


@main_bp.route("/meeting-types")
def meeting_types_page():
    """Render the meeting type prompt editor page."""
    return render_template("meeting_types.html")

