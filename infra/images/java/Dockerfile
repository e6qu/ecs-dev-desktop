# SPDX-License-Identifier: AGPL-3.0-or-later
# Golden workspace JAVA variant: the shared base + the JDK, Maven, and Gradle.
# Slim alternative to omnibus.
#
#   docker build -t edd-base infra/images/base
#   docker build --build-arg BASE=edd-base -t edd-workspace-java infra/images/java
ARG BASE=edd-base:latest
FROM ${BASE}

ENV GRADLE_HOME="/opt/gradle" \
    JAVA_HOME="/usr/lib/jvm/default-java"
ENV PATH="/opt/gradle/bin:${PATH}"

# JDK + Maven (both land on the base PATH: java via update-alternatives in /usr/bin,
# mvn in /usr/bin) + archive tools for the Gradle install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-jdk-headless maven unzip zip \
    && rm -rf /var/lib/apt/lists/*

# Gradle — current stable release into /opt/gradle (not on the base PATH).
RUN gradle_ver="$(curl -fsSL https://services.gradle.org/versions/current | sed -n 's/.*"version"[ ]*:[ ]*"\([^"]*\)".*/\1/p')" \
    && curl -fsSL "https://services.gradle.org/distributions/gradle-${gradle_ver}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && mv "/opt/gradle-${gradle_ver}" /opt/gradle \
    && rm /tmp/gradle.zip \
    && /opt/gradle/bin/gradle --version | grep -i version

# Java VS Code language support into the built-in extensions dir (baked at build).
RUN openvscode-server --install-extension redhat.java --extensions-dir /opt/openvscode-server/extensions \
    && chmod -R a+rX /opt/openvscode-server/extensions

# /opt/gradle/bin isn't on the base PATH — overwrite the PATH drop-ins so login
# shells and the ssh-exec channel both find `gradle` (+ export JAVA_HOME/GRADLE_HOME).
RUN printf '%s\n' \
      'export JAVA_HOME="/usr/lib/jvm/default-java"' \
      'export GRADLE_HOME="/opt/gradle"' \
      'export PATH="/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/opt/gradle/bin:${PATH}"' \
      > /etc/profile.d/edd-path.sh \
    && chmod 0644 /etc/profile.d/edd-path.sh
RUN printf '%s\n' \
      'SetEnv PATH=/home/workspace/.npm-global/bin:/home/workspace/.local/bin:/opt/gradle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
      > /etc/ssh/sshd_config.d/10-edd-path.conf \
    && chmod 0644 /etc/ssh/sshd_config.d/10-edd-path.conf
