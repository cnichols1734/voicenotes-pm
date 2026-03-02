"""
VoiceNotes PM - Authentication routes.
Handles login, registration, and logout.
"""
import logging

from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_user, logout_user, login_required, current_user

from services.auth_service import (
    get_user_by_email,
    create_user,
    check_password,
    claim_orphan_data,
)

logger = logging.getLogger(__name__)

auth_bp = Blueprint("auth", __name__)


@auth_bp.route("/login", methods=["GET"])
def login_page():
    """Render the login page. Redirect to dashboard if already logged in."""
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    return render_template("login.html")


@auth_bp.route("/login", methods=["POST"])
def login_submit():
    """Authenticate a user by email + password."""
    email = request.form.get("email", "").strip()
    password = request.form.get("password", "")

    if not email or not password:
        flash("Email and password are required.", "error")
        return render_template("login.html"), 400

    user = get_user_by_email(email)

    if user is None or not check_password(password, user._data.get("password_hash", "")):
        flash("Invalid email or password.", "error")
        return render_template("login.html"), 401

    if not user.is_active:
        flash("Your account has been disabled. Contact an administrator.", "error")
        return render_template("login.html"), 403

    login_user(user, remember=True)
    logger.info("User logged in: %s", user.email)
    return redirect(url_for("main.index"))


@auth_bp.route("/register", methods=["GET"])
def register_page():
    """Render the registration page."""
    if current_user.is_authenticated:
        return redirect(url_for("main.index"))
    return render_template("register.html")


@auth_bp.route("/register", methods=["POST"])
def register_submit():
    """Create a new user account."""
    email = request.form.get("email", "").strip()
    display_name = request.form.get("display_name", "").strip()
    password = request.form.get("password", "")
    confirm = request.form.get("confirm_password", "")

    errors = []
    if not email:
        errors.append("Email is required.")
    if not display_name:
        errors.append("Display name is required.")
    if not password or len(password) < 6:
        errors.append("Password must be at least 6 characters.")
    if password != confirm:
        errors.append("Passwords do not match.")

    if errors:
        for e in errors:
            flash(e, "error")
        return render_template("register.html"), 400

    # Check for duplicate email
    existing = get_user_by_email(email)
    if existing:
        flash("An account with that email already exists.", "error")
        return render_template("register.html"), 409

    # Determine role: admin if email matches ADMIN_EMAIL config
    from config import Config
    is_admin = email.lower().strip() == Config.ADMIN_EMAIL
    role = "admin" if is_admin else "user"

    try:
        user = create_user(email, password, display_name, role=role)
        logger.info("New user registered: %s (role=%s)", user.email, user.role)

        # If admin, claim any existing orphan data FIRST (before seeding)
        if is_admin:
            claim_orphan_data(user.id)

        # Seed default meeting types (skips if user already has types from orphan claim)
        try:
            from services.seed_defaults import seed_meeting_types_for_user
            seed_meeting_types_for_user(user.id)
        except Exception as exc:
            logger.warning("Failed to seed meeting types for new user: %s", exc)

        flash("Account created! Please log in.", "success")
        return redirect(url_for("auth.login_page"))

    except Exception as exc:
        logger.error("Registration failed: %s", exc)
        flash("Registration failed. Please try again.", "error")
        return render_template("register.html"), 500


@auth_bp.route("/logout", methods=["POST"])
@login_required
def logout():
    """Log out the current user."""
    logout_user()
    return redirect(url_for("auth.login_page"))
